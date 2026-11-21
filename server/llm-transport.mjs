/**
 * 外部模型传输层的插槽。
 *
 * 独立运行时保持 null：llm.mjs 直连 OpenAI 兼容接口。
 * 作为 DSH 插件运行时，插件会在导入本模块后调用 setLlmTransport()，
 * 把调用桥接到 Harness 的 ctx.llm（用户不再需要自己填 API Key）。
 *
 * 单独一个模块是为了避免 config.mjs 与 agent/llm.mjs 之间的循环依赖。
 */
let transport = null;

export function setLlmTransport(next) {
  transport = next;
}

export function getLlmTransport() {
  return transport;
}

export function hasLlmTransport() {
  return transport !== null;
}
