import { redirect } from "next/navigation";

/** 根路径：直接进入小红书工作区（无需平台选择） */
export default function Home() {
  redirect("/platforms/xhs/dashboard");
}
