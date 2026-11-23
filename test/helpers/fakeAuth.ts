import type { AuthGateway, Claims, CreateUserResult, SessionResult } from '@/lib/clients/authGateway';

type User = { id: string; email: string; password: string; username: string };

export class FakeAuth implements AuthGateway {
  users: User[] = [];
  forceSignInStatus: number | null = null;
  forceRefreshStatus: number | null = null;
  signedOut: string[] = [];
  deleted: string[] = [];
  private n = 0;

  addUser(u: User) { this.users.push(u); return u; }
  tokensFor(id: string) { return { accessToken: `at.${id}.${++this.n}`, refreshToken: `rt.${id}.${++this.n}` }; }
  /** Cookie header a signed-in browser would send. */
  cookieFor(id: string) { const t = this.tokensFor(id); return `optinex_at=${t.accessToken}; optinex_rt=${t.refreshToken}`; }

  async signInWithPassword(email: string, password: string): Promise<SessionResult> {
    if (this.forceSignInStatus) return { ok: false, status: this.forceSignInStatus, message: 'forced' };
    const u = this.users.find((x) => x.email === email && x.password === password);
    if (!u) return { ok: false, status: 400, message: 'Invalid login credentials' };
    return { ok: true, userId: u.id, tokens: this.tokensFor(u.id) };
  }
  async refreshSession(rt: string): Promise<SessionResult> {
    if (this.forceRefreshStatus) return { ok: false, status: this.forceRefreshStatus, message: 'forced' };
    const m = rt.match(/^rt\.(.+)\.\d+$/);
    if (!m) return { ok: false, status: 400, message: 'bad refresh token' };
    return { ok: true, userId: m[1], tokens: this.tokensFor(m[1]) };
  }
  async verify(at: string): Promise<Claims | null> {
    const m = at.match(/^at\.(.+)\.\d+$/);
    if (!m) return null;
    const u = this.users.find((x) => x.id === m[1]);
    return { sub: m[1], email: u?.email ?? '', username: u?.username ?? '', sessionId: 'sess-1' };
  }
  async signOut(at: string) { this.signedOut.push(at); }
  async createUser(i: { email: string; password: string; username: string }): Promise<CreateUserResult> {
    if (this.users.some((u) => u.email === i.email)) return { ok: false, message: 'User already registered' };
    const id = `11111111-1111-4111-8111-${String(this.users.length + 1).padStart(12, '0')}`;
    this.users.push({ id, email: i.email, password: i.password, username: i.username });
    return { ok: true, id };
  }
  async deleteUser(id: string) { this.deleted.push(id); this.users = this.users.filter((u) => u.id !== id); }
}
