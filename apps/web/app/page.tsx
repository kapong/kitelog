"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    api.me().then(
      () => router.replace("/projects"),
      () => router.replace("/login"),
    );
  }, [router]);
  return null;
}
