"use client";
import {
  CheckOutlined,
  CloseOutlined,
  CommentOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/layout/app-shell";
import {
  approveCommentReply,
  createReplyRule,
  deleteReplyRule,
  fetchCommentReplies,
  fetchReplyRules,
  skipCommentReply,
  updateReplyRule,
} from "@/lib/api";
import { formatShanghaiTime } from "@/lib/time";
import type { CommentReply, CommentReplyRule } from "@/types";

const { Text } = Typography;

const INTENT_OPTIONS = [
  { value: "question", label: "询问" },
  { value: "praise", label: "好评" },
  { value: "complaint", label: "差评" },
  { value: "ad", label: "广告" },
  { value: "other", label: "其他" },
];

const INTENT_COLOR: Record<string, string> = {
  question: "blue",
  praise: "green",
  complaint: "red",
  ad: "purple",
  other: "default",
};

/** 评论运营页（AI Agent 平台 D-05）：审核队列 + 回复规则 */
export default function CommentReplyPage() {
  const [replies, setReplies] = useState<CommentReply[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");
  const [actingId, setActingId] = useState<number | null>(null);

  // 规则管理
  const [showRules, setShowRules] = useState(false);
  const [rules, setRules] = useState<CommentReplyRule[]>([]);
  const [ruleForm] = Form.useForm<{ intent: string; keywords: string; reply_template: string }>();

  async function loadReplies() {
    setIsLoading(true);
    try {
      const result = await fetchCommentReplies(statusFilter || undefined);
      setReplies(result.items);
    } catch (error) {
      message.error(`加载评论队列失败: ${(error as Error).message}`);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadReplies();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  async function loadRules() {
    try {
      const result = await fetchReplyRules();
      setRules(result.items);
    } catch (error) {
      message.error(`加载回复规则失败: ${(error as Error).message}`);
    }
  }

  async function handleApprove(reply: CommentReply) {
    setActingId(reply.id);
    try {
      await approveCommentReply(reply.id);
      message.success("评论已回复");
      await loadReplies();
    } catch (error) {
      message.error(`回复失败: ${(error as Error).message}`);
    } finally {
      setActingId(null);
    }
  }

  async function handleSkip(reply: CommentReply) {
    setActingId(reply.id);
    try {
      await skipCommentReply(reply.id);
      message.success("已跳过该回复");
      await loadReplies();
    } catch (error) {
      message.error(`跳过失败: ${(error as Error).message}`);
    } finally {
      setActingId(null);
    }
  }

  async function handleCreateRule() {
    const values = await ruleForm.validateFields();
    try {
      await createReplyRule({
        intent: values.intent,
        keywords: values.keywords.split(/[,\n，]/).map((item) => item.trim()).filter(Boolean),
        reply_template: values.reply_template,
      });
      message.success("规则已添加");
      ruleForm.resetFields();
      await loadRules();
    } catch (error) {
      message.error(`添加规则失败: ${(error as Error).message}`);
    }
  }

  async function handleToggleRule(rule: CommentReplyRule) {
    try {
      await updateReplyRule(rule.id, { enabled: !rule.enabled });
      await loadRules();
    } catch (error) {
      message.error(`更新规则失败: ${(error as Error).message}`);
    }
  }

  async function handleDeleteRule(ruleId: number) {
    try {
      await deleteReplyRule(ruleId);
      message.success("规则已删除");
      await loadRules();
    } catch (error) {
      message.error(`删除规则失败: ${(error as Error).message}`);
    }
  }

  const columns: ColumnsType<CommentReply> = [
    { title: "ID", dataIndex: "id", width: 60 },
    {
      title: "意图",
      dataIndex: "intent",
      width: 90,
      render: (intent: string) => <Tag color={INTENT_COLOR[intent] ?? "default"}>{INTENT_OPTIONS.find((item) => item.value === intent)?.label ?? intent}</Tag>,
    },
    { title: "评论 ID", dataIndex: "comment_id", width: 130, ellipsis: true },
    {
      title: "回复内容",
      dataIndex: "reply_content",
      ellipsis: true,
      render: (content: string) => (content ? content : <Text type="secondary">（差评/广告，不自动回复）</Text>),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (status: string) => {
        const map: Record<string, { color: string; label: string }> = {
          pending: { color: "orange", label: "待审核" },
          published: { color: "green", label: "已回复" },
          skipped: { color: "default", label: "已跳过" },
          failed: { color: "red", label: "失败" },
        };
        const cfg = map[status] ?? { color: "default", label: status };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
    },
    { title: "时间", dataIndex: "created_at", width: 160, render: (value: string) => formatShanghaiTime(value) },
    {
      title: "操作",
      width: 170,
      render: (_, reply) =>
        reply.status === "pending" ? (
          <Space>
            <Button size="small" type="primary" icon={<CheckOutlined />} loading={actingId === reply.id} disabled={!reply.reply_content} onClick={() => void handleApprove(reply)}>
              回复
            </Button>
            <Button size="small" icon={<CloseOutlined />} onClick={() => void handleSkip(reply)}>
              跳过
            </Button>
          </Space>
        ) : null,
    },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Comments"
        title="评论运营"
        description="自动检测新评论并生成回复建议，人工确认后发布；差评与广告不自动回复。"
      />

      <Card
        title={
          <span>
            <CommentOutlined style={{ marginRight: 8 }} />
            回复审核队列
          </span>
        }
        extra={
          <Space>
            <Select
              allowClear
              placeholder="按状态筛选"
              style={{ width: 120 }}
              value={statusFilter || undefined}
              onChange={(value: string) => setStatusFilter(value ?? "")}
              options={[
                { value: "pending", label: "待审核" },
                { value: "published", label: "已回复" },
                { value: "skipped", label: "已跳过" },
              ]}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void loadReplies()}>
              刷新
            </Button>
            <Button
              icon={<SettingOutlined />}
              onClick={() => {
                setShowRules(true);
                void loadRules();
              }}
            >
              回复规则
            </Button>
          </Space>
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="系统每分钟检测已发布笔记的新评论（需绑定 PC 账号），生成回复建议后进入此队列，回复前请人工确认。"
        />
        <Table<CommentReply>
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={replies}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: "暂无评论回复任务" }}
        />
      </Card>

      {/* 回复规则管理 */}
      <Modal title="回复规则" open={showRules} onCancel={() => setShowRules(false)} footer={null} width={640}>
        <Form
          form={ruleForm}
          layout="vertical"
          initialValues={{ intent: "question", keywords: "", reply_template: "" }}
          onFinish={() => void handleCreateRule()}
          style={{ marginBottom: 16 }}
        >
          <Space align="start" wrap>
            <Form.Item name="intent" label="意图" rules={[{ required: true }]}>
              <Select style={{ width: 110 }} options={INTENT_OPTIONS} />
            </Form.Item>
            <Form.Item name="keywords" label="触发关键词（逗号分隔）">
              <Input placeholder="怎么,哪里,多少钱" style={{ width: 220 }} />
            </Form.Item>
            <Form.Item name="reply_template" label="回复模板（{question} 引用评论）">
              <Input placeholder="可以看看我的这篇笔记，有详细说明哦" style={{ width: 240 }} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" htmlType="submit" icon={<PlusOutlined />}>
                添加
              </Button>
            </Form.Item>
          </Space>
        </Form>
        <List
          size="small"
          dataSource={rules}
          locale={{ emptyText: "暂无自定义规则（无模型时会按关键词规则匹配）" }}
          renderItem={(rule) => (
            <List.Item
              actions={[
                <Button key="toggle" size="small" onClick={() => void handleToggleRule(rule)}>
                  {rule.enabled ? "停用" : "启用"}
                </Button>,
                <Popconfirm key="del" title="确认删除？" onConfirm={() => void handleDeleteRule(rule.id)}>
                  <Button size="small" danger>
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={
                  <Space>
                    <Tag color={INTENT_COLOR[rule.intent]}>{INTENT_OPTIONS.find((item) => item.value === rule.intent)?.label ?? rule.intent}</Tag>
                    <Text>{rule.reply_template || "(无模板)"}</Text>
                  </Space>
                }
                description={rule.keywords.length ? `触发词：${rule.keywords.join("、")}` : "任意评论"}
              />
            </List.Item>
          )}
        />
      </Modal>
    </div>
  );
}
