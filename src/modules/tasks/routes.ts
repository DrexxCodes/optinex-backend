import type { FastifyPluginAsync } from 'fastify';
import { HttpError, conflict } from '@/lib/errors';
import { generateReference } from '@/lib/refGenerator';
import { num, rpcMessage } from '@/lib/db/format';
import { paramsOf } from '../helpers';

const taskRoutes: FastifyPluginAsync = async (app) => {
  const { db, analytics } = app.c;
  app.addHook('preHandler', app.authenticate);

  // Active admin-created tasks. Once a user claims a reward the task disappears from their list for good.
  app.get('/', async (req) => {
    const [tasks, completed] = await Promise.all([
      db.from('tasks').select('id, name, details, button_label, link, reward').eq('active', true).order('created_at', { ascending: false }),
      db.from('completed_tasks').select('task_id').eq('user_id', req.session!.uid)
    ]);
    const completedIds = new Set((completed.data ?? []).map((c: any) => c.task_id as string));

    return {
      tasks: (tasks.data ?? [])
        .filter((t: any) => !completedIds.has(t.id))
        .map((t: any) => ({ id: t.id, name: t.name, details: t.details, buttonLabel: t.button_label, link: t.link, reward: num(t.reward) }))
    };
  });

  app.post('/:taskId/complete', async (req) => {
    const { data, error } = await db.rpc('complete_task', {
      p_user: req.session!.uid,
      p_task: paramsOf(req).taskId,
      p_ref: generateReference()
    });

    if (error) {
      const msg = rpcMessage(error);
      if (msg === 'ALREADY_COMPLETED') throw conflict('You already claimed this task.');
      if (msg === 'TASK_UNAVAILABLE') throw new HttpError(410, 'This task is no longer available.');
      console.error('[tasks/complete]', error);
      throw new HttpError(500, 'Could not complete task.');
    }

    const reward = Number(data);
    await analytics.safeLog('task_completed', reward, 'tasks/complete');
    return { ok: true, reward };
  });
};
export default taskRoutes;
