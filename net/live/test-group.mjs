// The live scripts' Entmoot group: GROUP=<base64 group id>, else the test build's (world/config/test.json)
import { readFileSync } from 'node:fs'
export const GROUP = process.env.GROUP || JSON.parse(readFileSync(new URL('../../world/config/test.json', import.meta.url), 'utf8')).group
