import type { FastifyPluginAsync } from 'fastify';
import { HttpError } from '@/lib/errors';
import { num } from '@/lib/db/format';
import { bodyOf, paramsOf } from '../helpers';

// API field -> column
const FIELD_MAP = { name: 'name', details: 'details', buttonLabel: 'button_label', link: 'link', reward: 'reward', active: 'active' } as const;

const taskAdminRoutes: FastifyPluginAsync = async (app) => {
  const { db } = app.c;

  app.get('/', async () => {
    const { data } = await db.from('tasks').select('id, name, details, button_label, link, reward, active').order('created_at', { ascending: false });
    return {
      tasks: (data ?? []).map((t: any) => ({
        id: t.id,
        name: t.name,
        details: t.details,
        buttonLabel: t.button_label ?? '',
        link: t.link ?? '',
        reward: num(t.reward),
        active: t.active !== false
      }))
    };
  });

  app.post('/', async (req) => {
    const { name, details, buttonLabel, link, reward } = bodyOf(req);
    if (!name || !details || !reward || reward <= 0) throw new HttpError(400, 'Name, details, and reward are required.');

    // buttonLabel/link are optional — blank means a plain "Complete" button with no outbound link.
    const { data, error } = await db
      .from('tasks')
      .insert({ name, details, button_label: buttonLabel || '', link: link || '', reward: Number(reward), active: true })
      .select('id')
      .single();
    if (error || !data) throw new HttpError(500, 'Could not create this task.');
    return { ok: true, id: data.id };
  });

  app.patch('/:id', async (req) => {
    const body = bodyOf(req);
    const update: Record<string, unknown> = {};
    for (const [key, column] of Object.entries(FIELD_MAP)) {
      if (body[key] !== undefined) update[column] = body[key];
    }
    if (Object.keys(update).length === 0) throw new HttpError(400, 'Nothing to update.');

    const { error } = await db.from('tasks').update(update).eq('id', paramsOf(req).id);
    if (error) throw new HttpError(500, 'Could not update this task.');
    return { ok: true };
  });

  app.delete('/:id', async (req) => {
    await db.from('tasks').delete().eq('id', paramsOf(req).id);
    return { ok: true };
  });
};
export default taskAdminRoutes;
