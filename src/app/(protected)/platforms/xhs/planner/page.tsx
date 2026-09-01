"use client";
import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  BulbOutlined,
  FireOutlined,
  PlusOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Drawer,
  Form,
  Input,
  InputNumber,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/layout/app-shell";
import {
  acceptSuggestion,
  analyzeExplosions,
  fetchExplosionReports,
  fetchHotTopicHistory,
  fetchHotTopics,
  fetchSuggestions,
  generateSuggestions,
  refreshHotTopics,
} from "@/lib/api";
import { formatShanghaiTime } from "@/lib/time";
import type { ExplosionReport, HotTopicEntry, TopicSuggestion } from "@/types";

const { Text, Paragraph } = Typography;

const CATEGORY_OPTIONS = ["美妆", "穿搭", "美食", "旅行", "家居", "知识", "其他"].map((value) => ({ value, label: value }));

function heatTag(entry: HotTopicEntry) {
  if (entry.rise_speed > 0) {
    return <Tag color="red"><ArrowUpOutlined /> {entry.rise_speed}%</Tag>;
  }
  if (entry.rise_speed < 0) {
    return <Tag color="green"><ArrowDownOutlined /> {entry.rise_speed}%</Tag>;
  }
  return <Tag>持平</Tag>;
}

/** 策划工作台（AI Agent 平台 P-01/P-02/P-03） */
export default function PlannerPage() {
  // 热点榜单
  const [hotItems, setHotItems] = useState<HotTopicEntry[]>([]);
  const [snapAt, setSnapAt] = useState<string | null>(null);
  const [category, setCategory] = useState<string>("");
  const [hotLoading, setHotLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [historyDrawer, setHistoryDrawer] = useState<{ keyword: string; items: Array<{ snap_at: string; heat_score: number; rise_speed: number; rank: number }> } | null>(null);

  // 爆款拆解
  const [analyzeForm] = Form.useForm<{ keyword: string; range_days: number }>();
  const [analyzing, setAnalyzing] = useState(false);
  const [reports, setReports] = useState<ExplosionReport[]>([]);
  const [reportDetail, setReportDetail] = useState<ExplosionReport | null>(null);
  const [showReport, setShowReport] = useState(false);

  // 选题推荐
  const [suggestions, setSuggestions] = useState<TopicSuggestion[]>([]);
  const [sugForm] = Form.useForm<{ count: number; direction: string }>();
  const [generating, setGenerating] = useState(false);

  async function loadHotTopics() {
    setHotLoading(true);
    try {
      const result = await fetchHotTopics(category || undefined);
      setHotItems(result.items);
      setSnapAt(result.snap_at);
    } catch (error) {
      message.error(`加载热点榜单失败: ${(error as Error).message}`);
    } finally {
      setHotLoading(false);
    }
  }

  useEffect(() => {
    void loadHotTopics();
    void loadReports();
    void loadSuggestions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadHotTopics();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [category]);

  async function handleRefresh() {
    setRefreshing(true);
    try {
      const result = await refreshHotTopics();
      message.success(`热点采集完成：收录 ${result.collected} 个话题（估算榜单，30 分钟自动更新）`);
      await loadHotTopics();
    } catch (error) {
      message.error(`热点采集失败: ${(error as Error).message}`);
    } finally {
      setRefreshing(false);
    }
  }

  async function openHistory(keyword: string) {
    try {
      const result = await fetchHotTopicHistory(keyword);
      setHistoryDrawer({ keyword: result.keyword, items: result.items });
    } catch (error) {
      message.error(`加载趋势失败: ${(error as Error).message}`);
    }
  }

  async function loadReports() {
    try {
      const result = await fetchExplosionReports();
      setReports(result.items);
    } catch {
      setReports([]);
    }
  }

  async function handleAnalyze() {
    const values = await analyzeForm.validateFields();
    setAnalyzing(true);
    try {
      const report = await analyzeExplosions(values.keyword.trim(), values.range_days);
      setReportDetail(report);
      setShowReport(true);
      message.success(`「${report.keyword}」爆款拆解完成`);
      await loadReports();
    } catch (error) {
      message.error(`爆款拆解失败: ${(error as Error).message}`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function loadSuggestions() {
    try {
      const result = await fetchSuggestions();
      setSuggestions(result.items);
    } catch {
      setSuggestions([]);
    }
  }

  async function handleGenerateSuggestions() {
    const values = await sugForm.validateFields();
    setGenerating(true);
    try {
      const result = await generateSuggestions({ count: values.count, direction: values.direction });
      message.success(`已生成 ${result.total} 条选题`);
      await loadSuggestions();
    } catch (error) {
      message.error(`选题生成失败: ${(error as Error).message}`);
    } finally {
      setGenerating(false);
    }
  }

  async function handleAccept(suggestion: TopicSuggestion) {
    try {
      const result = await acceptSuggestion(suggestion.id);
      message.success(`「${result.suggestion.title}」已加入草稿工坊（草稿 #${result.draft_id}）`);
      await loadSuggestions();
    } catch (error) {
      message.error(`采纳选题失败: ${(error as Error).message}`);
    }
  }

  const hotColumns: ColumnsType<HotTopicEntry> = [
    { title: "排名", dataIndex: "rank", width: 60, render: (rank: number) => <Text strong>{rank}</Text> },
    {
      title: "话题",
      dataIndex: "keyword",
      ellipsis: true,
      render: (keyword: string) => <a onClick={() => void openHistory(keyword)}>{keyword}</a>,
    },
    {
      title: "分类",
      dataIndex: "category",
      width: 80,
      render: (value: string) => <Tag>{value}</Tag>,
    },
    { title: "热度分", dataIndex: "heat_score", width: 90, render: (value: number) => <Text strong type="danger">{value}</Text> },
    { title: "趋势", dataIndex: "rise_speed", width: 90, render: (_: number, entry) => heatTag(entry) },
    { title: "笔记数", dataIndex: "search_count", width: 80 },
    { title: "笔记增量", dataIndex: "note_delta", width: 90 },
    { title: "互动增量", dataIndex: "interact_delta", width: 90 },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Planner"
        title="策划工作台"
        description="全站热点洞察、爆款结构拆解与智能选题推荐，热点榜单每 30 分钟自动更新（估算数据）。"
      />

      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        {/* P-01 热点榜单 */}
        <Card
          title={
            <span>
              <FireOutlined style={{ marginRight: 8, color: "#ff4d4f" }} />
              实时热点榜单
              {snapAt && <Text type="secondary" style={{ fontSize: 12, marginLeft: 12 }}>更新于 {snapAt}（估算）</Text>}
            </span>
          }
          extra={
            <Space>
              <Select
                allowClear
                placeholder="按分类筛选"
                style={{ width: 120 }}
                value={category || undefined}
                onChange={(value: string) => setCategory(value ?? "")}
                options={CATEGORY_OPTIONS}
              />
              <Button icon={<ReloadOutlined />} loading={refreshing} onClick={() => void handleRefresh()}>
                立即刷新
              </Button>
            </Space>
          }
        >
          {hotItems.length === 0 && !hotLoading && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="暂无热点数据：需绑定 PC 账号并配置关键词组，点击「立即刷新」手动采集"
            />
          )}
          <Table<HotTopicEntry>
            rowKey="keyword"
            size="small"
            loading={hotLoading}
            columns={hotColumns}
            dataSource={hotItems}
            pagination={{ pageSize: 10, showSizeChanger: false }}
          />
        </Card>

        {/* P-02 爆款拆解 */}
        <Card
          title={
            <span>
              <ThunderboltOutlined style={{ marginRight: 8, color: "#faad14" }} />
              爆款拆解
            </span>
          }
        >
          <Form form={analyzeForm} layout="inline" initialValues={{ range_days: 7 }}>
            <Form.Item name="keyword" rules={[{ required: true, message: "请输入关键词" }]}>
              <Input placeholder="目标关键词/类目，如：秋冬穿搭" style={{ width: 240 }} />
            </Form.Item>
            <Form.Item name="range_days" label="范围">
              <Select style={{ width: 120 }} options={[{ value: 7, label: "近 7 天" }, { value: 30, label: "近 30 天" }]} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" loading={analyzing} onClick={() => void handleAnalyze()}>
                开始拆解
              </Button>
            </Form.Item>
          </Form>
          {reports.length > 0 && (
            <List
              size="small"
              style={{ marginTop: 12 }}
              dataSource={reports.slice(0, 5)}
              renderItem={(report) => (
                <List.Item
                  actions={[
                    <Button key="view" size="small" type="link" onClick={() => { setReportDetail(report); setShowReport(true); }}>
                      查看报告
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={report.keyword}
                    description={`${report.range_days} 天范围 · ${report.sample_notes.length} 个爆款样本 · ${formatShanghaiTime(report.created_at)}`}
                  />
                </List.Item>
              )}
            />
          )}
        </Card>

        {/* P-03 选题推荐 */}
        <Card
          title={
            <span>
              <BulbOutlined style={{ marginRight: 8, color: "#1677ff" }} />
              选题推荐
            </span>
          }
        >
          <Form form={sugForm} layout="inline" initialValues={{ count: 5, direction: "" }}>
            <Form.Item name="count" label="数量">
              <Select style={{ width: 100 }} options={[{ value: 5, label: "5 条" }, { value: 10, label: "10 条" }, { value: 20, label: "20 条" }]} />
            </Form.Item>
            <Form.Item name="direction" label="内容方向">
              <Input placeholder="可选，如：职场通勤" style={{ width: 200 }} />
            </Form.Item>
            <Form.Item>
              <Button type="primary" icon={<BulbOutlined />} loading={generating} onClick={() => void handleGenerateSuggestions()}>
                生成选题
              </Button>
            </Form.Item>
          </Form>
          <List
            size="small"
            style={{ marginTop: 12 }}
            locale={{ emptyText: "暂无选题，点击「生成选题」基于知识库+热点+爆款结构生成" }}
            dataSource={suggestions}
            renderItem={(suggestion) => (
              <List.Item
                actions={[
                  suggestion.status === "open" ? (
                    <Popconfirm key="accept" title="加入内容生产队列（生成草稿）？" onConfirm={() => void handleAccept(suggestion)}>
                      <Button size="small" type="primary" icon={<PlusOutlined />}>
                        采纳
                      </Button>
                    </Popconfirm>
                  ) : (
                    <Tag key="accepted" color="green">已采纳</Tag>
                  ),
                ]}
              >
                <List.Item.Meta
                  title={
                    <Space wrap>
                      <Text strong>{suggestion.title}</Text>
                      <Tag color="blue">预估热度 {suggestion.predicted_heat}</Tag>
                      {suggestion.direction && <Tag>{suggestion.direction}</Tag>}
                    </Space>
                  }
                  description={
                    <Space wrap>
                      {suggestion.tags.map((tag) => (
                        <Tag key={tag}>#{tag}</Tag>
                      ))}
                      <Text type="secondary" style={{ fontSize: 12 }}>依据：{suggestion.source}</Text>
                    </Space>
                  }
                />
              </List.Item>
            )}
          />
        </Card>
      </Space>

      {/* 关键词热度趋势 */}
      <Drawer title={`热度趋势：${historyDrawer?.keyword ?? ""}`} open={Boolean(historyDrawer)} onClose={() => setHistoryDrawer(null)} width={420}>
        {historyDrawer && (
          <List
            size="small"
            dataSource={historyDrawer.items}
            renderItem={(item) => (
              <List.Item>
                <List.Item.Meta
                  title={`${item.snap_at} · 热度 ${item.heat_score}`}
                  description={`排名 ${item.rank} · ${item.rise_speed > 0 ? `上升 ${item.rise_speed}%` : item.rise_speed < 0 ? `下降 ${item.rise_speed}%` : "持平"}`}
                />
              </List.Item>
            )}
          />
        )}
      </Drawer>

      {/* 爆款拆解报告 */}
      <Modal
        title={reportDetail ? `爆款拆解报告：${reportDetail.keyword}` : "爆款拆解报告"}
        open={showReport}
        onCancel={() => setShowReport(false)}
        footer={null}
        width={680}
      >
        {reportDetail ? (
          <Spin spinning={false}>
            <Space direction="vertical" size="middle" style={{ width: "100%" }}>
              <ReportSection title="📝 标题公式" items={reportDetail.title_patterns} />
              <ReportSection title="🖼️ 封面要素" items={reportDetail.cover_patterns} />
              <ReportSection title="📄 正文框架" items={reportDetail.body_patterns} />
              <ReportSection title="💬 互动引导" items={reportDetail.engage_patterns} />
              <Card size="small" title={`分析样本（${reportDetail.sample_notes.length} 条低粉高互动笔记）`}>
                <List
                  size="small"
                  dataSource={reportDetail.sample_notes}
                  renderItem={(sample) => (
                    <List.Item>
                      <List.Item.Meta
                        title={sample.title}
                        description={`@${sample.author} · 赞 ${sample.likes} 藏 ${sample.collects} 评 ${sample.comments}`}
                      />
                    </List.Item>
                  )}
                />
              </Card>
            </Space>
          </Spin>
        ) : null}
      </Modal>
    </div>
  );
}

function ReportSection({ title, items }: { title: string; items: string[] }) {
  return (
    <Card size="small" title={title}>
      <List
        size="small"
        dataSource={items}
        renderItem={(item) => (
          <List.Item>
            <Paragraph style={{ margin: 0 }}>▶ {item}</Paragraph>
          </List.Item>
        )}
      />
    </Card>
  );
}
