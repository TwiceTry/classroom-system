# 这个目录已经空了

原来的 5 个文件都挪到了课程 assets 下：

```
data/courses/<courseId>/content/assets/lib/
  vue.global.js          前端代码练习页（pgPreview）用
  vue3-sfc-loader.js     同上，1.8MB
  sfc-boot.js            同上
  vue.global.prod.js     课程示例用
  jquery.min.js          课程示例用
```

理由：它们是**课程内容**（示例 html 里 <script src> 的依赖），
不该住在系统代码目录里。走 `/api/assets/lib/*` 免登录，
代理缓存 365 天（比原来 /lib/ 的 24 小时更长）。

`app.js` 里 `/lib/` 的 static 注册保留着（目录为空），
万一有旧引用遗漏，至少是 404 而不是崩掉。
