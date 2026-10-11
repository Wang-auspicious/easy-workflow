// 你自己在对话里的头像，任选其一。图片是 Grok Bot 0.43.0 安装包里自带的插画，
// 从它的 app.asar 里取出来的（见 ui/public/avatars/README.md 的来源说明）。
export const USER_AVATARS = [
  { id: "ada", name: "Ada", hint: "Ada Lovelace" },
  { id: "dijkstra", name: "Dijkstra", hint: "最短路径" },
  { id: "liskov", name: "Liskov", hint: "替换原则" },
  { id: "matsumoto", name: "Matsumoto", hint: "Ruby" },
  { id: "cerf", name: "Cerf", hint: "互联网协议" },
] as const;

export type UserAvatarId = (typeof USER_AVATARS)[number]["id"];
export const userAvatarSrc = (id: string) => `${import.meta.env.BASE_URL}avatars/${id}.svg`;
