import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

// 默认构建（npm run build）输出常规多文件 dist，供 GitHub Pages 部署；
// npm run build:single 输出全部内联的单文件 dist/index.html，
// 手机解压后直接点开即可运行（file:// 下外部 ES 模块会被拦截，必须内联）
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'singlefile' ? [viteSingleFile()] : [],
  build: {
    // 单文件模式要求把所有资源内联进唯一的 index.html，多入口会打架；
    // 所以 /admin 只在常规构建里出现 —— 顺手也让手机包里不带管理页
    rollupOptions: {
      input: mode === 'singlefile'
        ? { main: 'index.html' }
        : { main: 'index.html', admin: 'admin/index.html' },
    },
  },
  server: {
    port: 5173,
    open: false
  }
}))
