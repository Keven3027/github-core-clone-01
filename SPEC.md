# Forge 实现规格(集成契约)

入口:`node /bot/main.ts`(Node 22,仅标准库,无依赖,TypeScript 直接跑 type-stripping)。
starter 的 main.ts 生命周期保持不变;我们只扩展 `app.ts`。

## 文件所有权(严格)
- `src/gitcore.ts` + `src/store.ts` — git 代理负责:对象库、refs、pack 读写、smart HTTP(upload-pack v0/v2 + receive-pack v0)、底层提交操作。
- `src/rest.ts`、`src/graphql.ts`、`src/mcp.ts` — REST 代理负责。
- `src/model.ts` — 由 git 代理创建并拥有,定义共享数据模型;REST 代理只准 import、不准改。
- `app.ts` — 由主编排(我)集成,代理不要动 main.ts。

## 共享数据模型(model.ts,git 代理先写好此骨架,REST 代理照此用)
```ts
export interface Blob { data: Buffer }
export interface TreeEntry { mode: string; name: string; sha: string }
export interface Commit { tree: string; parents: string[]; author: {name: string; email: string; when: string}; message: string }
export interface RepoData {
  owner: string; name: string;
  description: string | null;
  defaultBranch: string;            // 'main'
  private: boolean;
  createdAt: string; updatedAt: string; pushedAt: string;
  refs: Map<string, string>;        // 'refs/heads/main' -> commit sha
  objects: Map<string, {type: 'blob'|'tree'|'commit'; data: Buffer}>;
  issues: Issue[]; pulls: Pull[]; labels: Label[];
}
export interface Issue { id: string; number: number; title: string; body: string; state: 'open'|'closed'; labels: string[]; createdAt: string; updatedAt: string; closedAt: string | null; user: string }
export interface Pull { id: string; number: number; title: string; body: string; state: 'open'|'closed'; merged: boolean; head: string; base: string; createdAt: string; user: string; mergeCommitSha: string | null }
export interface Label { name: string; color: string; description: string | null }
export class Forge {
  repos: Map<string, RepoData>;   // key: `${owner}/${name}`(大小写敏感)
  login: string;                  // MAKEFUN_SHOP_TOKEN 对应的登录名(环境变量注入)
  createRepo(owner: string, name: string, description?: string): RepoData
  getRepo(owner: string, name: string): RepoData | undefined
  deleteRepo(owner: string, name: string): void
}
export const forge = new Forge(); // 全局单例,REST/GraphQL/MCP/git 共用它
```
git 代理在 Forge 上追加的底层方法(REST 需要调用):
```ts
upsertFile(repo: RepoData, branch: string, path: string, content: Buffer, message: string): {commitSha: string, oldSha?: string}  // 含内容更新时返回旧 blob sha 以支持 409
deleteFile(repo: RepoData, branch: string, path: string, message: string): {commitSha: string}
squashMerge(repo: RepoData, headBranch: string, baseBranch: string, message: string): {sha: string} | 'conflict'   // 三方合并;冲突返回 'conflict',不移动 ref
listBranchCommits(repo: RepoData, branch: string, depth: number): Commit[]  // 供 clone/shallow 用
```

## 认证
所有 `/api/*`、`/api/graphql`、`/mcp`、`/{owner}/{repo}.git/*` 请求带 `Authorization: Bearer <MAKEFUN_SHOP_TOKEN>`(环境变量,main.ts 注入到 Forge.login)。缺失/错误 → 401 JSON。owner 不匹配 → 404。

## 路由分发(app.ts 集成顺序)
1. `/healthz`、`/api/v3` 根 → starter 已有
2. `startsWith('/api/v3/')` → rest.handle()
3. `/api/graphql` → graphql.handle()
4. `/mcp` → mcp.handle()
5. `*.git/info/refs`、`*.git/git-upload-pack`、`*.git/git-receive-pack` → git-http.handle()
6. 其余 → 404 {"message":"Not Found"}

通用响应头:所有 JSON 响应带 `X-GitHub-Request-Id`(随机不重复);错误体必须是 JSON `{"message": "..."}`,绝不 HTML;畸形 JSON 请求体 → 400。

## 运行环境
- node:`/root/makefun/node-v22.22.0-linux-x64/bin/node`(系统 node 22.13 没有 zstd 等新 API,统一用它)
- 套件源码(必读,按文件所有权读对应部分):`/root/makefun/github-core-clone-01-kit/program/env/src/`
- 规则:`/root/makefun/github-core-clone-01-kit/RULES.txt`
- 工作目录:`/root/makefun/work/`
- 测试:可写独立脚本(node 直接跑 .ts),自己起服务自己打;不要试图跑整套 grade-local(主编排负责)。
- 性能要点:200 push / 50 并发 shallow clone(200 提交)/ 2000 次读 / 200 次写,都要快;对象写内存即可(每 trial 新 pod,不需要持久化)。
