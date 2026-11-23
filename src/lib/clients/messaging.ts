// Firebase Cloud Messaging — push *delivery* only. Tokens and history live in Supabase.
import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getMessaging, type Message } from 'firebase-admin/messaging';
import type { Env } from '@/config/env';

export interface MessagingLike {
  send(message: Message): Promise<string>;
  subscribeToTopic(token: string, topic: string): Promise<unknown>;
  unsubscribeFromTopic(token: string, topic: string): Promise<unknown>;
}

export function createMessaging(env: Pick<Env, 'FIREBASE_PROJECT_ID' | 'FIREBASE_CLIENT_EMAIL' | 'FIREBASE_PRIVATE_KEY'>): MessagingLike {
  if (!env.FIREBASE_PROJECT_ID || !env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    const off = async (): Promise<never> => {
      throw new Error('Firebase is not configured (FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY).');
    };
    return { send: off, subscribeToTopic: off, unsubscribeFromTopic: off };
  }

  const app =
    getApps()[0] ??
    initializeApp({
      credential: cert({
        projectId: env.FIREBASE_PROJECT_ID,
        clientEmail: env.FIREBASE_CLIENT_EMAIL,
        // Private keys are stored with literal \n in env files — restore real newlines.
        privateKey: env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
  const m = getMessaging(app);
  return {
    send: (message) => m.send(message),
    subscribeToTopic: (token, topic) => m.subscribeToTopic(token, topic),
    unsubscribeFromTopic: (token, topic) => m.unsubscribeFromTopic(token, topic)
  };
}
