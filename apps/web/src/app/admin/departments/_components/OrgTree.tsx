"use client";

import { EmptyState, InlineError, Skeleton } from "@/components/admin-ui";
import type { OrgNode } from "@/lib/admin-api";

/** 單一節點：每層縮排 20px，圓點＋代碼＋名稱＋（有主管時）主管標籤；遞迴畫子節點。 */
function TreeNode({ node, depth }: { node: OrgNode; depth: number }) {
  return (
    <li>
      <div
        className="flex flex-wrap items-center gap-2 py-1.5"
        style={{ paddingLeft: `${depth * 20}px` }}
      >
        <span
          aria-hidden
          className="inline-block h-2 w-2 rounded-full"
          style={{ background: "var(--brand)" }}
        />
        <span className="font-mono text-xs text-gray-400">{node.code}</span>
        <span className="font-medium text-gray-800">{node.name}</span>
        {node.managerLabel && (
          <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
            {node.managerLabel}
          </span>
        )}
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * 部門頁右側的組織圖（原 /admin/org-chart 頁抽出，該頁已改 redirect 到 /admin/departments）。
 * 資料由父層 load() 與部門／員工一起抓（getOrgChart）；新增／更新／刪除後父層重抓即同步更新。
 */
export function OrgTree({ tree, loading, error }: { tree: OrgNode[]; loading: boolean; error: string | null }) {
  return (
    <>
      {error && <InlineError className="mb-3">{error}</InlineError>}
      {loading ? (
        <Skeleton lines={5} />
      ) : tree.length === 0 ? (
        <EmptyState title="尚無部門" hint="新增單位後，這裡會依上層單位畫出階層" />
      ) : (
        <ul>
          {tree.map((n) => (
            <TreeNode key={n.id} node={n} depth={0} />
          ))}
        </ul>
      )}
    </>
  );
}
