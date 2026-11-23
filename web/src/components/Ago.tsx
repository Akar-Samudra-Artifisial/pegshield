"use client";

import { useEffect, useState } from "react";
import { ago } from "@/lib/format";

interface Props {
  ts: number;
  prefix?: string;
  className?: string;
}

/** Relative time that ticks on its own, so the parent does not re-render every second. */
export function Ago({ ts, prefix = "", className }: Props) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, []);

  return (
    <span className={className} aria-hidden="true">
      {prefix}
      {ago(ts, now)}
    </span>
  );
}
