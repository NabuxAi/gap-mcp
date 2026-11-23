// Gap MCP server: the official bot API and the user's own account through Gap Web.
import { createMessengerServer, runStdio } from '@nabuxai/iranian-messaging-core';
import { gap as botAdapter } from './bot.mjs';
import { gap as webDriver } from './web.mjs';

export { botAdapter, webDriver };
export const options = { id: 'gap', label: 'Gap', botAdapter, webDriver };
export const createServer = (extra = {}) => createMessengerServer({ ...options, ...extra });
export const start = (extra = {}) => runStdio({ ...options, ...extra });
