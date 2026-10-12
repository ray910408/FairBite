// 重新產生 src/lib/database.types.ts。不用 shell 的 >：它在命令執行前就截斷檔案，stack 沒起或
// Docker 沒開時會把已 commit 的型別檔清空（CLI 的錯誤訊息還會印在 stdout 被寫進去）；
// 這裡只有 gen types 成功且有輸出才覆寫。
// 本機 stack 有本 repo migration 以外的物件（例如跟別的 session 共用）時，改指向隔離 stack 的目錄：
//   npm run gen:types -- <那份 supabase/ 的上一層目錄>
// supabase@ 版本要跟 .github/workflows/ci.yml（db、e2e 兩個 job）與 deploy-pages.yml 的
// setup-cli version 同步：postgres-meta 映像跟著 CLI 版本走，只升一處 CI 的型別 diff 就會假紅
import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const workdir = process.argv[2] ?? '..'
const gen = spawnSync(
  `npx -y supabase@2.113.0 gen types typescript --local --schema public --workdir "${workdir}"`,
  { shell: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
)
if (gen.status !== 0 || !gen.stdout.trim()) {
  console.error(gen.stdout || 'supabase gen types 沒有輸出')
  console.error('保留原本的 src/lib/database.types.ts')
  process.exit(1)
}
writeFileSync('src/lib/database.types.ts', gen.stdout)
