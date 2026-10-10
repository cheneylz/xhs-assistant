"use client";
/**
 * Agent 工作台（P1-B：三栏界面 + SSE 实时过程）
 *
 * 数据来源严格分工（设计稿 §5.3）：
 *   首屏 / 重同步：fetchAgentConversation → 快照整体替换（agentReducer 的 snapshot）
 *   SSE 增量：useAgentEvents → 逐帧身份幂等归并（agentReducer 的 frame）
 *
 * 【快照与连接必须配对】agent-state.ts 的 applyFirstScreen 会把水位回退到快照的
 * latest_event_id（快照在途期间连接推的更新帧会被替换丢掉），所以每次应用快照之后
 * 都要 `streamKey + 1` 重连、从快照水位重放（幂等归并不会重复渲染）。
 * 【agent_end 后延迟重同步】worker 在循环结束后才写 Run 终态与会话 idle，
 * 立刻重拉可能读到「还在 running」的旧快照。
 * 【执行中每 5s 兜底校正】见下面的 settleRunStatus —— 覆盖「快照恰落在 agent_end 与
 * finishRun 之间」的毫秒级窗口（该窗口重连补不回结束信号，见 agent-state.ts 文件头）。
 */
import { memo, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { SendOutlined } from "@ant-design/icons";
import { Button, Empty, Input, Space, Tag, Typography, message } from "antd";

import { ArtifactPanel } from "@/components/agent/artifact-panel";
import { ConversationList } from "@/components/agent/conversation-list";
import { MessageStream } from "@/components/agent/message-stream";
import { useAgentEvents } from "@/components/agent/use-agent-events";
import { agentReducer, createInitialState, upsertConversation } from "@/lib/agent/agent-state";
import {
  cancelAgentRun,
  createAgentConversation,
  deleteAgentConversation,
  fetchAgentArtifacts,
  fetchAgentConversation,
  fetchAgentConversations,
  sendAgentMessage,
} from "@/lib/api";
import type { AgentConversation, AgentConversationDetail } from "@/types";

const { Text } = Typography;

/** agent_end 之后延迟多久重同步（等 worker 写完 Run 终态与会话 idle） */
const RESYNC_AFTER_RUN_END_MS = 800;

/**
 * memo 包一层（Task 7 质量审查的量化的建议）：SSE 每帧都会产生新的 state 对象 →
 * 页面每帧重渲染，而约 95% 的帧 `items` 引用完全没变（噪声帧只推进水位）。
 * 没有这层，每帧都会重建整棵时间线（数百个 antd 组件）—— 一轮 1400 帧是几十万次
 * 无谓的渲染。四个 props 全是布尔或稳定引用，memo 命中率高。
 * Task 12 可用 React Profiler 做一次开/关对照实测。
 */
const MemoMessageStream = memo(MessageStream);

export default function AgentWorkspacePage() {
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  /** 正在删除的会话 id（传给左栏，禁用该行按钮防重复提交） */
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  /** 已应用过快照、可以订阅 SSE 的会话 id（null = 同步中，不连接） */
  const [syncedId, setSyncedId] = useState<number | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [streamKey, setStreamKey] = useState(0);
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [refreshingArtifacts, setRefreshingArtifacts] = useState(false);
  const [draft, setDraft] = useState("");
  const [state, dispatch] = useReducer(agentReducer, undefined, createInitialState);

  /** 当前选中的会话 id（异步回调里读最新值，避免把旧闭包的结果写回状态） */
  const selectionRef = useRef<number | null>(null);

  const executing = state.runStatus.executing;
  const pendingRunId = state.runStatus.pendingRunIds.length > 0 ? state.runStatus.pendingRunIds[0] : null;

  /** 快照是否已应用到当前选中的会话：未应用前不允许发送（否则在途快照会整体替换时间线、
   *  抹掉刚发出的用户消息 —— 它不在事件流里，水位重放补不回来。整体终审 I1） */
  const composerReady = selectedId !== null && syncedId === selectedId;

  const refreshList = useCallback(async () => {
    try {
      setConversations(await fetchAgentConversations());
    } catch {
      // 刷新失败不打断使用（拦截器已提示）
    }
  }, []);

  /**
   * 应用快照：三件事必须一起做（见文件头的不变量）——
   *   1) 整体替换状态（snapshot）
   *   2) 重连 SSE 从快照水位重放（bump streamKey）
   *   3) 武装订阅（syncedId）—— 漏了这步，首屏失败后 resync 成功了也永远不订阅
   *      （Task 10 质量审查 I1：页面会永久失去直播通道与 5s 兜底）
   */
  const applySnapshot = useCallback((id: number, detail: AgentConversationDetail) => {
    dispatch({ type: "snapshot", detail });
    setStreamKey((key) => key + 1);
    setSyncedId(id);
  }, []);

  /** 重同步：拉首屏快照整体替换，然后重连 SSE 从快照水位重放（见文件头） */
  const resync = useCallback(async () => {
    const id = selectionRef.current;
    if (id === null) return;
    try {
      const detail = await fetchAgentConversation(id);
      if (selectionRef.current !== id) return; // 已切到别的会话，丢弃过期响应
      applySnapshot(id, detail);
    } catch {
      // 静默：下一次交互会再同步
    }
  }, [applySnapshot]);

  const loadDetail = useCallback(
    async (id: number) => {
      setDetailLoading(true);
      try {
        const detail = await fetchAgentConversation(id);
        if (selectionRef.current !== id) return;
        applySnapshot(id, detail);
      } catch {
        // 不在这里卸 syncedId（原因见上）；handleSelect 已经把订阅关掉过了
      } finally {
        if (selectionRef.current === id) setDetailLoading(false);
      }
    },
    [applySnapshot],
  );

  const handleSelect = useCallback(
    (id: number) => {
      selectionRef.current = id;
      setSelectedId(id);
      setSyncedId(null); // 断开旧会话的 SSE（effect 依赖变化 → abort），清空串台数据
      dispatch({ type: "clear" });
      setDraft("");
      void loadDetail(id);
      // 顺手刷列表：会话行的「执行中」标记只来自列表接口，切走期间别的会话跑完了不会自动更新 ——
      // 不刷的话「点回旧会话」会出现「中栏说空闲、左栏还在转」的自相矛盾（Task 6 质量审查发现）
      void refreshList();
    },
    [loadDetail, refreshList],
  );

  // 首屏：拉会话列表，自动选中最近一个
  // 首屏只跑一次：依赖里的 handleSelect 必须是稳定引用（空依赖 useCallback）——
  // 任何为 loadDetail 加依赖的改动都会让首屏 effect 重跑，把用户强制拉回列表第一项（审查 M2）
  useEffect(() => {
    void (async () => {
      try {
        const items = await fetchAgentConversations();
        setConversations(items);
        if (items.length > 0) handleSelect(items[0].id);
      } catch {
        // 拦截器已提示
      } finally {
        setListLoading(false);
      }
    })();
  }, [handleSelect]);

  // SSE：会话切换 / 主动重启（streamKey）时重连
  useAgentEvents({
    conversationId: syncedId,
    streamKey,
    lastEventId: state.lastEventId,
    hasActiveRun: executing,
    onEvent: (frame) => dispatch({ type: "frame", frame }),
    onRunEnded: () => {
      // agent_end：循环已结束。稍等再重同步 —— worker 紧接着才写 Run 终态与会话 idle。
      // 重连后 agent_end 可能被重放一次（水位落后一个提交时）→ 至多多一次无害的重同步，
      // 不做去重。
      window.setTimeout(() => {
        void resync();
        // 首轮结束后标题会按首条消息派生，updated_at 排序也可能变
        void refreshList();
      }, RESYNC_AFTER_RUN_END_MS);
    },
  });

  /**
   * 兜底校正执行状态（仅执行中，每 5s 一次）。
   *
   * 动机：worker 先落 agent_end、后写 Run 终态（finishRun）—— 若某次快照恰在这个
   * 毫秒级窗口返回，水位已越过 agent_end，重连补不回结束信号，UI 会卡在「执行中」
   * （输入框禁用、也没有取消按钮）。定时读一次服务端 runs 把状态收敛。
   * 只发 runStatus 动作（不动时间线 / 水位 / 工件），因此不需要重连 SSE。
   * 这一拍拉的是**完整首屏契约**（接口 3，只为读 runs）——执行中每 5s 一次是可接受的代价，
   * 真嫌重再考虑给接口 3 加字段过滤（登记在交接文档）。
   *
   * 已知无害竞态（登记在交接文档，不做机制兜底）：一次在途的请求若在新一轮
   * 「发送 → runCreated」之后才落地，会把 executing 短暂抹回 false（新 Run 不在
   * 那份过期响应里）—— 用户若立刻再发会吃到 409，拦截器提示并自动重同步，自愈。
   */
  const settleRunStatus = useCallback(async () => {
    const id = selectionRef.current;
    if (id === null) return;
    try {
      // silent=true：失败不弹 toast（每 5s 一拍，抖动连发会刷屏），靠下一拍自愈
      const detail = await fetchAgentConversation(id, true);
      if (selectionRef.current !== id) return;
      dispatch({ type: "runStatus", runs: detail.runs });
    } catch {
      // 静默：下一拍再试
    }
  }, []);

  useEffect(() => {
    if (!executing || syncedId === null) return;
    const timer = window.setInterval(() => void settleRunStatus(), 5000);
    return () => window.clearInterval(timer);
  }, [executing, syncedId, settleRunStatus]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const conversation = await createAgentConversation();
      setConversations((items) => upsertConversation(items, conversation));
      handleSelect(conversation.id);
    } catch {
      // 拦截器已提示
    } finally {
      setCreating(false);
    }
  }, [handleSelect]);

  /**
   * 删除会话（P1-D）：成功即把该行从列表移除；若删的是**当前选中**会话，
   * 把工作台清回空态（syncedId=null 会随 effect 依赖断开 SSE）。
   * 失败（409 执行中 / 404 已被删）由拦截器 toast —— 之后 refreshList 对齐
   * 「执行中」标记与行集合（左栏标记来自列表接口快照，可能滞后）。
   * 【契约】不要把 onDelete 改成 void、也不要去掉这里的 try/catch ——
   * 前者会让 Popconfirm 的确认按钮失去 loading（antd 靠 thenable 自动接管），后者会造成 unhandled rejection。
   */
  const handleDelete = useCallback(
    async (id: number) => {
      setDeletingId(id);
      try {
        await deleteAgentConversation(id);
        setConversations((items) => items.filter((item) => item.id !== id));
        // 删的正是当前选中的会话：清空工作台（用户删除时可能在途切走，故用 ref 比对）
        if (selectionRef.current === id) {
          selectionRef.current = null;
          setSelectedId(null);
          setSyncedId(null);
          dispatch({ type: "clear" });
          setDraft("");
        }
        message.success("会话已删除");
      } catch {
        // 拦截器已提示；刷新列表让「执行中」标记等状态与库对齐
        void refreshList();
      } finally {
        setDeletingId(null);
      }
    },
    [refreshList],
  );

  const handleSend = useCallback(async () => {
    const id = selectionRef.current;
    const content = draft.trim();
    // syncedId !== id：当前会话的快照还没落地，此时发送会被在途快照抹掉且无法恢复（终审 I1）
    if (id === null || syncedId !== id || !content || sending || executing) return;
    setSending(true);
    try {
      const result = await sendAgentMessage(id, content);
      // 已切走：A 的消息与执行中状态不能写进 B 的时间线，更不能清掉 B 的草稿（Task 10 审查 C1）
      if (selectionRef.current !== id) return;
      dispatch({
        type: "runCreated",
        conversation: result.conversation,
        message: result.message,
        run: result.run,
      });
      setConversations((items) => upsertConversation(items, result.conversation));
      setDraft("");
      // 重连一次：空闲时服务端 SSE 循环要 5s 才醒，重连让它立刻看到 pending 的 Run、切回 500ms 快查
      setStreamKey((key) => key + 1);
    } catch {
      // 409（会话正在执行）等错误已由拦截器提示；重同步把「执行中」状态对齐
      void resync();
    } finally {
      setSending(false);
    }
  }, [draft, executing, resync, sending, syncedId]);

  const handleCancel = useCallback(async () => {
    if (pendingRunId === null) return;
    const id = selectionRef.current;
    setCancelling(true);
    try {
      await cancelAgentRun(pendingRunId);
      // 已切走：A 的取消结果不能改写 B 的执行中状态（Task 10 审查 I3）
      if (selectionRef.current !== id) return;
      dispatch({ type: "runCancelled" });
      message.success("已取消等待中的任务");
    } catch {
      // 409：已被 worker 领走开始执行 —— 重同步对齐状态（按钮随之隐藏）
      void resync();
    } finally {
      setCancelling(false);
    }
  }, [pendingRunId, resync]);

  const handleRefreshArtifacts = useCallback(async () => {
    const id = selectionRef.current;
    if (id === null) return;
    setRefreshingArtifacts(true);
    try {
      const items = await fetchAgentArtifacts(id);
      // 已切走：A 的工件不能写进 B 的右栏（Task 10 审查 I2）
      if (selectionRef.current !== id) return;
      dispatch({ type: "artifacts", items });
    } catch {
      // 拦截器已提示
    } finally {
      setRefreshingArtifacts(false);
    }
  }, []);

  return (
    <div style={{ display: "flex", gap: 16, height: "calc(100vh - 96px)" }}>
      <ConversationList
        items={conversations}
        selectedId={selectedId}
        loading={listLoading}
        creating={creating}
        deletingId={deletingId}
        onSelect={handleSelect}
        onCreate={() => void handleCreate()}
        onDelete={handleDelete}
      />

      <div
        style={{
          flex: 1,
          // 两栏固定 260 + 320、左右 sider 与内边距约 300 —— 窄视口下给中栏留一个下限，
          // 靠 Content 的 overflow 出横向滚动条，而不是把消息流挤成一条缝
          minWidth: 420,
          display: "flex",
          flexDirection: "column",
          background: "#fff",
          border: "1px solid #f0f0f0",
          borderRadius: 10,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderBottom: "1px solid #f0f0f0",
          }}
        >
          <Text strong ellipsis style={{ fontSize: 14, flex: 1, minWidth: 0 }}>
            {state.conversation?.title ?? "Agent 工作台"}
          </Text>
          {executing && <Tag color="processing">执行中</Tag>}
        </div>

        {selectedId === null ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <Empty description={listLoading ? "加载中…" : "选择或新建一个会话开始"} />
          </div>
        ) : (
          <>
            <MemoMessageStream
              items={state.timeline}
              executing={executing}
              truncated={state.eventsTruncated || state.toolCallsTruncated}
              loading={detailLoading}
            />

            <div style={{ borderTop: "1px solid #f0f0f0", padding: 12 }}>
              <Input.TextArea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  // 输入法合成态里的 Enter 是「确认候选词」，不是提交 —— 误发的代价是让 Agent
                  // 拿半句话去执行工具（Task 10 审查 C2）。keyCode 229 是部分输入法在
                  // 合成期的另一种上报方式，一并挡掉。
                  if (
                    event.key === "Enter" &&
                    !event.shiftKey &&
                    !event.nativeEvent.isComposing &&
                    event.nativeEvent.keyCode !== 229
                  ) {
                    event.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="描述你的任务（Enter 发送，Shift+Enter 换行）"
                autoSize={{ minRows: 1, maxRows: 4 }}
                maxLength={4000}
                disabled={executing || !composerReady}
              />
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  marginTop: 8,
                }}
              >
                <Text type="secondary" style={{ fontSize: 12 }}>
                  {executing ? "执行中，完成后可继续对话" : composerReady ? "" : "正在加载会话…"}
                </Text>
                <Space>
                  {pendingRunId !== null && (
                    <Button size="small" loading={cancelling} onClick={() => void handleCancel()}>
                      取消任务
                    </Button>
                  )}
                  <Button
                    type="primary"
                    size="small"
                    icon={<SendOutlined />}
                    loading={sending}
                    disabled={executing || !composerReady || !draft.trim()}
                    onClick={() => void handleSend()}
                  >
                    发送
                  </Button>
                </Space>
              </div>
            </div>
          </>
        )}
      </div>

      <ArtifactPanel
        artifacts={state.artifacts}
        truncated={state.artifactsTruncated}
        loading={detailLoading}
        refreshing={refreshingArtifacts}
        disabled={selectedId === null}
        onRefresh={handleRefreshArtifacts}
      />
    </div>
  );
}
