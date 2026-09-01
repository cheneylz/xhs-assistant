"use client";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  FileSearchOutlined,
  PlusOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
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
  autoFixReview,
  batchReview,
  createComplianceRule,
  deleteComplianceRule,
  fetchComplianceRules,
  fetchDrafts,
  fetchReviewJob,
  fetchReviewJobs,
  submitReview,
  updateComplianceRule,
} from "@/lib/api";
import { formatShanghaiTime } from "@/lib/time";
import type { ComplianceRule, Draft, ReviewFinding, ReviewJob } from "@/types";

const { Text, Paragraph } = Typography;
const { TextArea } = Input;

// ---------- 状态配置 ----------

const REVIEW_STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: "default", label: "待审校" },
  passed: { color: "green", label: "✅ 通过" },
  warning: { color: "orange", label: "⚠️ 需修改" },
  rejected: { color: "red", label: "❌ 不通过" },
};

const GATE_STATUS: Record<string, { color: string; label: string }> = {
  pending: { color: "default", label: "门禁未跑" },
  passed: { color: "green", label: "门禁通过" },
  warning: { color: "orange", label: "门禁警告" },
  blocked: { color: "red", label: "门禁阻断" },
};

const RISK_TYPE_LABEL: Record<string, string> = {
  absolute_claim: "绝对化用语",
  medical_claim: "功效宣称",
  fake_data: "虚假数据",
  sensitive_word: "敏感词",
  inducement: "诱导行为",
  copyright: "版权风险",
  duplicate: "内容重复",
  other: "其他",
};

const GATE_LABEL: Record<string, string> = {
  claim: "声明验证",
  originality: "原创性检查",
  compliance: "合规检查",
  rule: "规则命中",
};

const RULE_TYPE_OPTIONS = [
  { value: "sensitive_word", label: "敏感词" },
  { value: "absolute_claim", label: "绝对化用语" },
  { value: "medical_claim", label: "功效宣称" },
  { value: "inducement", label: "诱导行为" },
  { value: "fake_data_pattern", label: "虚假数据" },
];

function statusTag(status: string) {
  const cfg = REVIEW_STATUS[status] ?? { color: "default", label: status };
  return <Tag color={cfg.color}>{cfg.label}</Tag>;
}

function gateTag(status: string) {
  const cfg = GATE_STATUS[status] ?? { color: "default", label: status };
  return <Tag color={cfg.color}>{cfg.label}</Tag>;
}

function riskLevelTag(level: string) {
  return level === "error" ? <Tag color="red">error</Tag> : <Tag color="orange">warning</Tag>;
}

// ---------- 审校工作台 ----------

export default function ReviewPage() {
  const [jobs, setJobs] = useState<ReviewJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>("");

  // 提交审校
  const [showSubmit, setShowSubmit] = useState(false);
  const [showBatch, setShowBatch] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [submitDraftId, setSubmitDraftId] = useState<number | null>(null);
  const [submitTitle, setSubmitTitle] = useState("");
  const [submitBody, setSubmitBody] = useState("");
  const [batchDraftIds, setBatchDraftIds] = useState<number[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 审校报告
  const [detail, setDetail] = useState<ReviewJob | null>(null);
  const [isFixing, setIsFixing] = useState(false);

  // 规则管理
  const [showRules, setShowRules] = useState(false);
  const [rules, setRules] = useState<ComplianceRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);

  async function loadJobs() {
    setIsLoading(true);
    try {
      const result = await fetchReviewJobs({ status: statusFilter || undefined });
      setJobs(result.items);
    } catch (error) {
      message.error(`加载审校队列失败: ${(error as Error).message}`);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadJobs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  async function loadDrafts() {
    try {
      const result = await fetchDrafts("xhs");
      setDrafts(result.items);
    } catch {
      setDrafts([]);
    }
  }

  function openSubmit() {
    setSubmitDraftId(null);
    setSubmitTitle("");
    setSubmitBody("");
    setShowSubmit(true);
    void loadDrafts();
  }

  async function handleSubmit() {
    setIsSubmitting(true);
    try {
      const job = await submitReview({
        source_draft_id: submitDraftId,
        ...(submitDraftId ? {} : { title: submitTitle, body: submitBody }),
      });
      message.success(`审校完成：${job.status === "passed" ? "通过" : `发现 ${job.risk_count} 个风险点`}`);
      setShowSubmit(false);
      setDetail(job);
      await loadJobs();
    } catch (error) {
      message.error(`提交审校失败: ${(error as Error).message}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleBatch() {
    if (!batchDraftIds.length) {
      message.warning("请先选择要批量审校的草稿");
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await batchReview(batchDraftIds);
      const passed = result.items.filter((item) => item.review.status === "passed").length;
      message.success(`批量审校完成：共 ${result.total} 条，通过 ${passed} 条`);
      setShowBatch(false);
      setBatchDraftIds([]);
      await loadJobs();
    } catch (error) {
      message.error(`批量审校失败: ${(error as Error).message}`);
    } finally {
      setIsSubmitting(false);
    }
  }

  async function openDetail(jobId: number) {
    try {
      const job = await fetchReviewJob(jobId);
      setDetail(job);
    } catch (error) {
      message.error(`加载审校报告失败: ${(error as Error).message}`);
    }
  }

  async function handleAutoFix() {
    if (!detail) return;
    setIsFixing(true);
    try {
      const job = await autoFixReview(detail.id);
      message.success(
        job.status === "passed" ? "修复完成，审校已通过" : `修复完成，仍有 ${job.risk_count} 个风险点待处理`,
      );
      setDetail(job);
      await loadJobs();
    } catch (error) {
      message.error(`自动修复失败: ${(error as Error).message}`);
    } finally {
      setIsFixing(false);
    }
  }

  async function loadRules() {
    setRulesLoading(true);
    try {
      const result = await fetchComplianceRules();
      setRules(result.items);
    } catch (error) {
      message.error(`加载规则库失败: ${(error as Error).message}`);
    } finally {
      setRulesLoading(false);
    }
  }

  function openRules() {
    setShowRules(true);
    void loadRules();
  }

  const columns: ColumnsType<ReviewJob> = [
    {
      title: "ID",
      dataIndex: "id",
      width: 60,
    },
    {
      title: "内容标题",
      dataIndex: "title",
      ellipsis: true,
      render: (title: string, record) => (
        <a onClick={() => void openDetail(record.id)}>{title || "(无标题)"}</a>
      ),
    },
    {
      title: "审校状态",
      dataIndex: "status",
      width: 110,
      render: (status: string) => statusTag(status),
    },
    {
      title: "三道门禁",
      dataIndex: "gate_status",
      width: 110,
      render: (status: string) => gateTag(status),
    },
    {
      title: "风险点",
      dataIndex: "risk_count",
      width: 80,
      render: (count: number) => <Text type={count > 0 ? "danger" : "secondary"}>{count}</Text>,
    },
    {
      title: "审校时间",
      dataIndex: "created_at",
      width: 170,
      render: (value: string) => formatShanghaiTime(value),
    },
    {
      title: "操作",
      key: "actions",
      width: 160,
      render: (_, record) => (
        <Space>
          <Button size="small" icon={<FileSearchOutlined />} onClick={() => void openDetail(record.id)}>
            报告
          </Button>
          {record.status !== "passed" && record.gate_status !== "pending" && (
            <Button size="small" type="primary" icon={<ThunderboltOutlined />} onClick={() => void handleAutoFixById(record.id)}>
              修复
            </Button>
          )}
        </Space>
      ),
    },
  ];

  async function handleAutoFixById(jobId: number) {
    setIsFixing(true);
    try {
      const job = await autoFixReview(jobId);
      message.success(job.status === "passed" ? "修复完成，审校已通过" : `修复完成，仍有 ${job.risk_count} 个风险点`);
      setDetail(job);
      await loadJobs();
    } catch (error) {
      message.error(`自动修复失败: ${(error as Error).message}`);
    } finally {
      setIsFixing(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="Review"
        title="审校工作台"
        description="双层内容预审（规则+语义）、声明验证、原创性检查、合规检查与梯度修复，三道门禁阻断违规内容发布。"
      />

      <Card
        style={{ marginBottom: 16 }}
        title={
          <span>
            <SafetyCertificateOutlined style={{ marginRight: 8 }} />
            待审队列
          </span>
        }
        extra={
          <Space>
            <Select
              allowClear
              placeholder="按状态筛选"
              style={{ width: 130 }}
              value={statusFilter || undefined}
              onChange={(value: string) => setStatusFilter(value ?? "")}
              options={Object.entries(REVIEW_STATUS).map(([value, cfg]) => ({ value, label: cfg.label }))}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void loadJobs()}>
              刷新
            </Button>
            <Button icon={<PlusOutlined />} onClick={openSubmit}>
              提交审校
            </Button>
            <Button
              icon={<ExclamationCircleOutlined />}
              onClick={() => {
                setBatchDraftIds([]);
                setShowBatch(true);
                void loadDrafts();
              }}
            >
              批量审校
            </Button>
            <Button icon={<SettingOutlined />} onClick={openRules}>
              规则管理
            </Button>
          </Space>
        }
      >
        <Table<ReviewJob>
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={jobs}
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: "暂无审校任务，点击「提交审校」开始" }}
        />
      </Card>

      {/* 提交审校 */}
      <Modal
        title="提交审校"
        open={showSubmit}
        onOk={() => void handleSubmit()}
        onCancel={() => setShowSubmit(false)}
        confirmLoading={isSubmitting}
        width={560}
      >
        <Form layout="vertical">
          <Form.Item label="选择草稿（或直接填写下方文本）">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="从草稿工坊选择待审内容"
              value={submitDraftId ?? undefined}
              onChange={(value: number | undefined) => setSubmitDraftId(value ?? null)}
              options={drafts.map((draft) => ({
                value: draft.id,
                label: `${draft.id} - ${draft.title || "(无标题)"}`,
              }))}
            />
          </Form.Item>
          {!submitDraftId && (
            <>
              <Form.Item label="标题">
                <Input value={submitTitle} onChange={(e) => setSubmitTitle(e.target.value)} placeholder="待审标题" />
              </Form.Item>
              <Form.Item label="正文">
                <TextArea rows={6} value={submitBody} onChange={(e) => setSubmitBody(e.target.value)} placeholder="待审正文内容" />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>

      {/* 批量审校 */}
      <Modal
        title="批量审校"
        open={showBatch}
        onOk={() => void handleBatch()}
        onCancel={() => setShowBatch(false)}
        confirmLoading={isSubmitting}
        width={560}
      >
        <Select
          mode="multiple"
          style={{ width: "100%" }}
          placeholder="选择要批量审校的草稿"
          value={batchDraftIds}
          onChange={(values: number[]) => setBatchDraftIds(values)}
          options={drafts.map((draft) => ({
            value: draft.id,
            label: `${draft.id} - ${draft.title || "(无标题)"}`,
          }))}
        />
      </Modal>

      {/* 审校报告 */}
      <Drawer
        title={detail ? `审校报告 #${detail.id}` : "审校报告"}
        open={Boolean(detail)}
        onClose={() => setDetail(null)}
        width={680}
        extra={
          detail && detail.status !== "passed" && detail.gate_status !== "pending" ? (
            <Button type="primary" icon={<ThunderboltOutlined />} loading={isFixing} onClick={() => void handleAutoFix()}>
              一键修复
            </Button>
          ) : null
        }
      >
        {detail && (
          <Space direction="vertical" size="middle" style={{ width: "100%" }}>
            <Descriptions size="small" column={3}>
              <Descriptions.Item label="审校状态">{statusTag(detail.status)}</Descriptions.Item>
              <Descriptions.Item label="三道门禁">{gateTag(detail.gate_status)}</Descriptions.Item>
              <Descriptions.Item label="风险点">{detail.risk_count}</Descriptions.Item>
            </Descriptions>

            <Card size="small" title="内容预览">
              <Paragraph strong>{detail.title}</Paragraph>
              <Paragraph ellipsis={{ rows: 6, expandable: true, symbol: "展开" }} style={{ whiteSpace: "pre-wrap" }}>
                {detail.body}
              </Paragraph>
            </Card>

            <Card size="small" title={`风险点（${detail.findings.length}）`}>
              {detail.findings.length === 0 ? (
                <Alert type="success" showIcon message="未发现风险点" />
              ) : (
                <List
                  dataSource={detail.findings}
                  renderItem={(finding: ReviewFinding) => (
                    <List.Item>
                      <List.Item.Meta
                        title={
                          <Space wrap>
                            <Tag color={finding.gate === "claim" ? "geekblue" : finding.gate === "originality" ? "purple" : "blue"}>
                              {GATE_LABEL[finding.gate] ?? finding.gate}
                            </Tag>
                            <Tag>{RISK_TYPE_LABEL[finding.risk_type] ?? finding.risk_type}</Tag>
                            {riskLevelTag(finding.risk_level)}
                            {finding.fixed && <Tag color="green">已修复（{finding.fix_action}）</Tag>}
                          </Space>
                        }
                        description={
                          <div>
                            <div>
                              <Text type="danger">命中片段：</Text>
                              <Text code>{finding.snippet}</Text>
                            </div>
                            <div style={{ marginTop: 4 }}>
                              <Text>建议：{finding.suggestion}</Text>
                            </div>
                            {finding.fixed_text && (
                              <div style={{ marginTop: 4 }}>
                                <Text type="success">修复后：{finding.fixed_text}</Text>
                              </div>
                            )}
                          </div>
                        }
                      />
                    </List.Item>
                  )}
                />
              )}
            </Card>
          </Space>
        )}
      </Drawer>

      {/* 规则管理 */}
      <RulesManagerModal
        open={showRules}
        onClose={() => setShowRules(false)}
        rules={rules}
        loading={rulesLoading}
        onReload={() => void loadRules()}
        onChange={(rule) => {
          setRules((prev) => prev.map((item) => (item.id === rule.id ? rule : item)));
        }}
      />
    </div>
  );
}

// ---------- 规则管理 ----------

function RulesManagerModal(props: {
  open: boolean;
  onClose: () => void;
  rules: ComplianceRule[];
  loading: boolean;
  onReload: () => void;
  onChange: (rule: ComplianceRule) => void;
}) {
  const [form] = Form.useForm<{ rule_type: string; pattern: string; is_regex: boolean; risk_level: "warning" | "error" }>();
  const [saving, setSaving] = useState(false);

  async function handleCreate(values: { rule_type: string; pattern: string; is_regex: boolean; risk_level: "warning" | "error" }) {
    setSaving(true);
    try {
      await createComplianceRule({ ...values });
      message.success("规则已添加");
      form.resetFields();
      props.onReload();
    } catch (error) {
      message.error(`添加规则失败: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handleToggle(rule: ComplianceRule) {
    try {
      const updated = await updateComplianceRule(rule.id, { enabled: !rule.enabled });
      props.onChange(updated);
    } catch (error) {
      message.error(`更新规则失败: ${(error as Error).message}`);
    }
  }

  async function handleDelete(ruleId: number) {
    try {
      await deleteComplianceRule(ruleId);
      message.success("规则已删除");
      props.onReload();
    } catch (error) {
      message.error(`删除规则失败: ${(error as Error).message}`);
    }
  }

  return (
    <Modal title="合规规则库" open={props.open} onCancel={props.onClose} footer={null} width={640}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="内置默认规则（绝对化用语/功效宣称/敏感词/诱导行为/虚假数据）始终生效，此处可添加自定义规则，关键词用 | 分隔。"
      />
      <Form
        form={form}
        layout="inline"
        onFinish={(values) => void handleCreate(values)}
        initialValues={{ rule_type: "sensitive_word", is_regex: false, risk_level: "warning" }}
        style={{ marginBottom: 16 }}
      >
        <Form.Item name="rule_type" rules={[{ required: true }]}>
          <Select style={{ width: 130 }} options={RULE_TYPE_OPTIONS} />
        </Form.Item>
        <Form.Item name="pattern" rules={[{ required: true, message: "请输入关键词或正则" }]}>
          <Input placeholder="关键词（| 分隔）或正则" style={{ width: 240 }} />
        </Form.Item>
        <Form.Item name="risk_level">
          <Select style={{ width: 100 }} options={[{ value: "warning", label: "warning" }, { value: "error", label: "error" }]} />
        </Form.Item>
        <Form.Item name="is_regex" valuePropName="checked">
          <Select style={{ width: 90 }} options={[{ value: false, label: "关键词" }, { value: true, label: "正则" }]} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={saving}>
            添加
          </Button>
        </Form.Item>
      </Form>

      <Table<ComplianceRule>
        rowKey="id"
        size="small"
        loading={props.loading}
        pagination={false}
        dataSource={props.rules}
        locale={{ emptyText: "暂无自定义规则" }}
        columns={[
          {
            title: "类型",
            dataIndex: "rule_type",
            render: (value: string) => RULE_TYPE_OPTIONS.find((item) => item.value === value)?.label ?? value,
          },
          { title: "关键词/正则", dataIndex: "pattern", ellipsis: true },
          {
            title: "等级",
            dataIndex: "risk_level",
            width: 90,
            render: (value: string) => riskLevelTag(value),
          },
          {
            title: "状态",
            dataIndex: "enabled",
            width: 90,
            render: (enabled: boolean) => (enabled ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: "操作",
            width: 130,
            render: (_, rule) => (
              <Space>
                <Button size="small" onClick={() => void handleToggle(rule)}>
                  {rule.enabled ? "停用" : "启用"}
                </Button>
                <Popconfirm title="确认删除该规则？" onConfirm={() => void handleDelete(rule.id)}>
                  <Button size="small" danger>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
    </Modal>
  );
}
