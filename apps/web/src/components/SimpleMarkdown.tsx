import type { ReactNode } from "react";

/**
 * 極簡 Markdown：只認 `#`/`##` 標題、`-`/`*` 清單、空行分段、**粗體**。
 * 公司資訊頁與知識庫回答共用；不引入 markdown 套件，也不允許 HTML（純文字轉義）。
 */
export function SimpleMarkdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let para: string[] = [];
  let list: string[] = [];
  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={blocks.length} className="mb-3 text-sm leading-6 text-gray-800">{inline(para.join(" "))}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={blocks.length} className="mb-3 list-disc space-y-1 pl-5 text-sm text-gray-800">
          {list.map((l, i) => <li key={i}>{inline(l)}</li>)}
        </ul>,
      );
      list = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (h) {
      flushPara(); flushList();
      const level = h[1].length;
      const cls = level === 1 ? "mb-2 mt-4 text-base font-semibold text-gray-900" : "mb-1 mt-3 text-sm font-semibold text-gray-800";
      blocks.push(level === 1 ? <h3 key={blocks.length} className={cls}>{inline(h[2])}</h3> : <h4 key={blocks.length} className={cls}>{inline(h[2])}</h4>);
    } else if (li) {
      flushPara();
      list.push(li[1]);
    } else if (!line.trim()) {
      flushPara(); flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara(); flushList();
  if (blocks.length === 0) return <p className="text-sm text-gray-400">（尚無內容）</p>;
  return <div>{blocks}</div>;
}

function inline(s: string): ReactNode {
  const parts = s.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith("**") && p.endsWith("**") ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>));
}
