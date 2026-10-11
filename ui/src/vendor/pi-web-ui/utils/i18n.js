// Easy Workflow sidebar adapter: strings used by the vendored message components.
const zh = { "Error:": "出错了：", "Request aborted": "已停止回答", Call: "调用参数", Result: "返回结果", "(no result)": "尚无结果", Free: "免费" };
export const i18n = (text) => zh[text] ?? text;
