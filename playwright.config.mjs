// 自動測試設定：用假的雲端資料打開網頁，檢查主要功能（不會碰到真的 Firebase）
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests",
  testMatch: /.*\.spec\.mjs/,
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  use: {
    trace: "off",
    // 本機若已有安裝好的 Chromium（PW_CHROMIUM），直接用；GitHub 上用 playwright install 裝的
    launchOptions: process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {},
  },
});
