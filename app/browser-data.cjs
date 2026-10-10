const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const webURL = value => { const u = new URL(value); if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) throw new Error('请输入 http / https 网址'); return u.href; };
const defaults = [ ['x', 'X', 'https://x.com/home'], ['xhs', '小红书', 'https://www.xiaohongshu.com/explore'], ['douyin', '抖音', 'https://www.douyin.com/'], ['bilibili', 'B 站', 'https://www.bilibili.com/'] ].map(([id,title,url]) => ({id,title,url}));

class BrowserData {
  constructor(file) {
    this.file = file;
    let saved = {}; try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    this.bookmarks = Array.isArray(saved.bookmarks) ? saved.bookmarks : defaults;
    this.history = Array.isArray(saved.history) ? saved.history : [];
    this.retentionDays = Number.isInteger(saved.retentionDays) ? Math.min(365, Math.max(1, saved.retentionDays)) : 30;
    this.tabs = Array.isArray(saved.tabs) ? saved.tabs.slice(0, 20) : [];
    this.prune();
  }
  prune(now = Date.now()) { this.history = this.history.filter(h => Number.isFinite(h.at) && now - h.at < this.retentionDays * 86400000).slice(-2000); }
  visit(url, title) {
    if (!/^https?:/.test(url)) return;
    const last = this.history.at(-1);
    if (last?.url === url && Date.now() - last.at < 5000) { last.title = title; last.at = Date.now(); }
    else this.history.push({ url, title, at: Date.now() });
    this.prune(); this.save();
  }
  change(action, args) {
    if (action === 'bookmark.add') { const url = webURL(args.url); if (!this.bookmarks.some(b => b.url === url)) this.bookmarks.push({ id: crypto.randomUUID(), url, title: String(args.title || new URL(url).hostname).slice(0, 60) }); }
    else if(action==='bookmark.update'){const item=this.bookmarks.find(b=>b.id===args.id);if(!item)throw new Error('收藏已不存在');const url=webURL(args.url);item.url=url;item.title=String(args.title||new URL(url).hostname).slice(0,60);}
    else if (action === 'bookmark.remove') this.bookmarks = this.bookmarks.filter(b => b.id !== args.id);
    else if (action === 'bookmark.move') { const i = this.bookmarks.findIndex(b => b.id === args.id), j = this.bookmarks.findIndex(b => b.id === args.before); if (i >= 0 && j >= 0 && i !== j) { const [item] = this.bookmarks.splice(i, 1); this.bookmarks.splice(this.bookmarks.findIndex(b => b.id === args.before), 0, item); } }
    else if (action === 'history.prune') { if (args.days !== undefined) { if (!Number.isInteger(args.days) || args.days < 1 || args.days > 365) throw new Error('历史保留天数须为 1–365'); this.retentionDays = args.days; } this.prune(); }
    else throw new Error('未知浏览器资料操作');
    this.save();
  }
  save() { fs.mkdirSync(path.dirname(this.file), { recursive: true }); const tmp = `${this.file}.tmp`; fs.writeFileSync(tmp, JSON.stringify({ bookmarks: this.bookmarks, history: this.history, retentionDays: this.retentionDays, tabs: this.tabs })); fs.renameSync(tmp, this.file); }
}
module.exports = { BrowserData, webURL };
