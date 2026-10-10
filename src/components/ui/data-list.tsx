"use client";
/**
 * DataList —— 替代 antd 废弃的 List 组件
 *
 * antd v6 起 `List` 被标记为废弃（每次渲染都会打印告警，v7 将移除），因此自研这一组组件顶上。
 *
 * 【重要】接口刻意只覆盖本项目实际用到的子集，**不是 antd List 的等价替身**。
 * 有意不实现：grid / pagination / loading / bordered / header / footer / itemLayout。
 * 迁移或新增调用点时请勿依赖上述能力，需要时应另行补实现。
 *
 * 与 antd 的层叠次序保持一致的两条关键约定：
 *  1) 行内边距写在 CSS class 里（值随 size 变化），调用点用行内 style 即可覆盖；
 *  2) 分隔线用 CSS :last-child 实现 —— 调用点的行内 border 既压过基规则、
 *     也压过 :last-child，这样「末行不留线」与「末行仍要留线」两种写法都能正确工作。
 */
import { Empty, theme } from "antd";
import { cloneElement, isValidElement, type CSSProperties, type HTMLAttributes, type ReactElement, type ReactNode } from "react";

export type DataListSize = "small" | "default" | "large";

export interface DataListProps<T> extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  /** 数据源；为空时渲染空态（不渲染 ul，因此也不会有分隔线残留） */
  dataSource?: readonly T[];
  /** 行渲染函数，第二参为下标 */
  renderItem?: (item: T, index: number) => ReactNode;
  /**
   * 行内边距档位（语义与 antd 一致：**只影响行的 padding，不影响字号**）
   * - small   → 8px 16px
   * - default → 12px 0
   * - large   → 16px 24px
   */
  size?: DataListSize;
  /** 行之间是否画分隔线（最后一行不画，因此比其它行矮 1px —— 与 antd 一致）。默认 true */
  split?: boolean;
  /** 空态内容。字符串会渲染成居中的朴素文案（与 antd 的字符串空态一致） */
  emptyText?: ReactNode;
  /** 兼容 antd 写法 `locale={{ emptyText }}`，新代码请直接用 emptyText */
  locale?: { emptyText?: ReactNode };
  /** 行 key：字段名或取值函数；缺省时依次退回 item.key、下标 */
  rowKey?: keyof T | ((item: T) => string | number);
  /** 整表容器样式（drafts / rewrite 等靠它做 maxHeight + overflowY 滚动） */
  style?: CSSProperties;
  className?: string;
}

export interface DataListItemProps extends Omit<HTMLAttributes<HTMLLIElement>, "children"> {
  /** 行右侧操作组：与内容**同一行**、右对齐、垂直居中；项之间自动插入竖线分隔 */
  actions?: ReactNode[];
  /** 行右侧附属内容：与 actions 同排，排在 actions 之后 */
  extra?: ReactNode;
  children?: ReactNode;
}

export interface DataListItemMetaProps {
  avatar?: ReactNode;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  style?: CSSProperties;
  className?: string;
}

/** 取行 key：rowKey 优先，其次 item.key，最后退回下标 */
function resolveRowKey<T>(item: T, index: number, rowKey?: keyof T | ((item: T) => string | number)) {
  if (rowKey) {
    return typeof rowKey === "function" ? rowKey(item) : (item[rowKey] as string | number);
  }
  const fallback = (item as { key?: string | number } | null)?.key;
  return fallback ?? `data-list-item-${index}`;
}

export function DataList<T>({
  dataSource,
  renderItem,
  size = "default",
  split = true,
  emptyText,
  locale,
  rowKey,
  style,
  className,
  ...rest
}: DataListProps<T>) {
  const token = theme.useToken().token;
  const items = dataSource ?? [];

  // 行内边距：与 antd 的 itemPadding / itemPaddingSM / itemPaddingLG 同源
  const itemPadding = {
    small: `${token.paddingContentVerticalSM}px ${token.paddingContentHorizontal}px`,
    default: `${token.paddingContentVertical}px 0`,
    large: `${token.paddingContentVerticalLG}px ${token.paddingContentHorizontalLG}px`,
  }[size];

  // 复刻 antd 的 resetComponent：根节点自带字体与盒模型，
  // 这样放在非 antd 容器里（例如通知下拉）也不会继承 body 的字号/行高
  const rootStyle: CSSProperties = {
    boxSizing: "border-box",
    margin: 0,
    padding: 0,
    color: token.colorText,
    fontSize: token.fontSize,
    lineHeight: token.lineHeight,
    fontFamily: token.fontFamily,
    listStyle: "none",
    position: "relative",
    ["--dl-item-padding" as string]: itemPadding,
    ["--dl-split-color" as string]: token.colorSplit,
    ["--dl-color-text-disabled" as string]: token.colorTextDisabled,
    ...style,
  };

  const classNames = ["data-list", split ? "data-list--split" : "", className ?? ""].filter(Boolean).join(" ");

  if (!renderItem || items.length === 0) {
    return (
      <div className={classNames} style={rootStyle} {...rest}>
        <div className="data-list__empty">
          {emptyText ?? locale?.emptyText ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />}
        </div>
      </div>
    );
  }

  return (
    <div className={classNames} style={rootStyle} {...rest}>
      <ul className="data-list__items">
        {items.map((item, index) => {
          const node = renderItem(item, index);
          // 调用点通常已经写了 key；没写时在这里补上，避免 React 告警
          if (!isValidElement(node)) return node;
          if (node.key != null) return node;
          return cloneElement(node as ReactElement, { key: resolveRowKey(item, index, rowKey) });
        })}
      </ul>
    </div>
  );
}

export function DataListItem({ actions, extra, children, className, ...rest }: DataListItemProps) {
  const hasActions = Array.isArray(actions) && actions.length > 0;

  return (
    <li className={["data-list__item", className ?? ""].filter(Boolean).join(" ")} {...rest}>
      {children}
      {hasActions && (
        <div className="data-list__actions">
          {actions.map((action, index) => (
            <span className="data-list__action" key={index}>
              {action}
              {index < actions.length - 1 && <span className="data-list__action-split" />}
            </span>
          ))}
        </div>
      )}
      {extra}
    </li>
  );
}

export function DataListItemMeta({ avatar, title, description, children, style, className }: DataListItemMetaProps) {
  const token = theme.useToken().token;

  return (
    <div
      className={["data-list__meta", className ?? ""].filter(Boolean).join(" ")}
      style={{ display: "flex", flex: 1, alignItems: "flex-start", maxWidth: "100%", ...style }}
    >
      {avatar && <div style={{ marginInlineEnd: token.padding }}>{avatar}</div>}
      {(title || description || children) && (
        // flex:"1 0" + width:0 是 antd 的原始写法，保证长文本换行宽度与迁移前一致
        <div className="data-list__meta-content" style={{ flex: "1 0", width: 0, color: token.colorText }}>
          {title && (
            // 保留 h4 标签：现状的粗体来自 UA 的 h4{font-weight:bold}，换标签会改变 18 处标题的字重
            <h4
              className="data-list__meta-title"
              style={{ margin: `0 0 ${token.marginXXS}px 0`, color: token.colorText, fontSize: token.fontSize, lineHeight: token.lineHeight }}
            >
              {title}
            </h4>
          )}
          {description && (
            <div
              className="data-list__meta-description"
              style={{ color: token.colorTextDescription, fontSize: token.fontSize, lineHeight: token.lineHeight }}
            >
              {description}
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
