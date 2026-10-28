#!/usr/bin/env node
// nodekb —— 命令行入口（不依赖 DSH 宿主）
import { runCli } from '../lib/cli.js'

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code
})
