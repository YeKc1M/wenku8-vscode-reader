import * as cheerio from 'cheerio';
import { ORIGIN, allowedUrl } from './model';
import { SiteError } from './network';

export interface AuthState { status: 'loggedOut' | 'restoring' | 'loggingIn' | 'verification' | 'loggedIn' | 'expired'; username?: string; }
export function parseLoginForm(html: string): { url: string; fields: Record<string, string> } {
  const $ = cheerio.load(html);
  const form = $('form').filter((_, el) => $(el).find('input[name="password"]').length > 0).first();
  if (!form.length || !form.find('input[name="username"]').length) throw new Error('登录表单结构已改变，暂时无法登录。');
  const url = new URL(form.attr('action') || '/login.php?do=submit', ORIGIN);
  allowedUrl(url.href);
  if (url.pathname !== '/login.php' || form.attr('method')?.toLowerCase() !== 'post') throw new Error('登录表单地址无效。');
  if (form.find('input').toArray().some(el => /captcha|checkcode|verifycode/i.test($(el).attr('name') ?? ''))) {
    throw new SiteError('verification', '登录需要额外验证码。请在 VS Code 内完成验证并登录，再点击「验证完成，继续」。');
  }
  const fields: Record<string, string> = Object.create(null);
  form.find('input[type="hidden"], input[type="submit"][name]').each((_, el) => {
    const name = $(el).attr('name'); if (name) fields[name] = $(el).attr('value') ?? '';
  });
  fields.usecookie = '2592000';
  return { url: url.href, fields };
}
export function loggedIn(html: string): boolean {
  const $ = cheerio.load(html);
  return $('a[href]').toArray().some(el => {
    try { const url = new URL($(el).attr('href')!, ORIGIN); return url.origin === ORIGIN && url.pathname === '/logout.php'; } catch { return false; }
  });
}
export function loginFailure(html: string): string {
  const $ = cheerio.load(html);
  const text = $('#content, .blockcontent, .error').text().replace(/\s+/g, ' ').trim();
  if (/密码|用户名|账号|帐号|用户不存在|登录失败|登陆失败/.test(text)) return '登录失败，请检查账号或密码。';
  return '未能确认登录成功，请检查账号密码后重试。';
}
