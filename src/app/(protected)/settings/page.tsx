"use client";
import {
  BookOutlined,
  HeartOutlined,
  LineChartOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import { Alert, Button, Card, Col, Form, Image, Input, List, Popconfirm, Row, Space, Table, Tag, Typography, message } from "antd";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/layout/app-shell";
import { useAuth } from "@/hooks/use-auth";
import {
  addFewShotNote,
  analyzeFewShotStyle,
  deleteFewShotNote,
  fetchAccountHealth,
  fetchFewShotNotes,
  fetchKnowledgeBase,
  fetchSavedNotes,
  fetchUsageSummary,
  updateKnowledgeBase,
} from "@/lib/api";
import type { AccountHealth, FewShotNote, KnowledgeBase, UsageSummary } from "@/types";

const { Paragraph, Text, Title } = Typography;
const { TextArea } = Input;

// ---------- 知识库管理（AI Agent 平台 S-02 / C-07）----------

function KnowledgeBaseCard() {
  const [kb, setKb] = useState<KnowledgeBase | null>(null);
  const [samples, setSamples] = useState<FewShotNote[]>([]);
  const [saving, setSaving] = useState(false);
  const [claimsText, setClaimsText] = useState("");

  // 从内容库挑选样本
  const [libraryNotes, setLibraryNotes] = useState<Array<{ id: number; title: string }>>([]);
  const [pickedNoteId, setPickedNoteId] = useState<number | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  async function loadAll() {
    try {
      const [kbRes, samplesRes] = await Promise.all([fetchKnowledgeBase(null), fetchFewShotNotes(null)]);
      setKb(kbRes);
      setSamples(samplesRes.items);
      setClaimsText(Array.isArray(kbRes.credible_claims) ? kbRes.credible_claims.join("\n") : "");
    } catch (error) {
      message.error(`加载知识库失败: ${(error as Error).message}`);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  async function handleSave() {
    if (!kb) return;
    setSaving(true);
    try {
      const updated = await updateKnowledgeBase({
        positioning: kb.positioning,
        tone_style: kb.tone_style,
        credible_claims: claimsText.split("\n").map((line) => line.trim()).filter(Boolean),
        content_boundary: kb.content_boundary,
      });
      setKb(updated);
      message.success("知识库已保存，后续生成内容自动生效");
    } catch (error) {
      message.error(`保存知识库失败: ${(error as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  async function handlePickAnalyze() {
    if (!pickedNoteId) {
      message.warning("请先从内容库选择一篇笔记");
      return;
    }
    setAnalyzing(true);
    try {
      const result = await analyzeFewShotStyle({ note_id: pickedNoteId });
      const added = await addFewShotNote({
        note_id: pickedNoteId,
        style_analysis: result.style_analysis,
        sort_order: samples.length,
      });
      setSamples((prev) => [...prev, added]);
      message.success("已加入风格样本并完成 LLM 风格分析");
      setPickedNoteId(null);
    } catch (error) {
      message.error(`添加风格样本失败: ${(error as Error).message}`);
    } finally {
      setAnalyzing(false);
    }
  }

  async function handleDeleteSample(id: number) {
    try {
      await deleteFewShotNote(id);
      setSamples((prev) => prev.filter((item) => item.id !== id));
      message.success("样本已删除");
    } catch (error) {
      message.error(`删除样本失败: ${(error as Error).message}`);
    }
  }

  async function loadLibraryNotes() {
    try {
      const result = await fetchSavedNotes("xhs");
      setLibraryNotes(result.items.map((note) => ({ id: note.id, title: note.title })));
    } catch {
      setLibraryNotes([]);
    }
  }

  return (
    <Card
      title={
        <span>
          <BookOutlined style={{ marginRight: 8 }} />
          账号知识库
        </span>
      }
      extra={
        <Text type="secondary">
          AI 内容生成时自动注入：定位、口吻、可信主张、经验结论与风格样本
        </Text>
      }
    >
      {!kb ? (
        <Alert type="info" showIcon message="加载中…" />
      ) : (
        <Form layout="vertical">
          <Row gutter={16}>
            <Col xs={24} lg={12}>
              <Form.Item label="账号定位（一句话描述，如：专注25+职场女性的穿搭指南）">
                <Input
                  value={kb.positioning}
                  onChange={(e) => setKb({ ...kb, positioning: e.target.value })}
                  placeholder="例如：专注 25+ 职场女性的穿搭指南"
                />
              </Form.Item>
            </Col>
            <Col xs={24} lg={12}>
              <Form.Item label="口吻风格（亲切/专业/幽默/温暖）">
                <Input
                  value={kb.tone_style}
                  onChange={(e) => setKb({ ...kb, tone_style: e.target.value })}
                  placeholder="例如：亲切、像闺蜜聊天"
                />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="可信主张（每行一条，生成内容可引用的真实背景）">
            <TextArea
              rows={2}
              value={claimsText}
              onChange={(e) => setClaimsText(e.target.value)}
              placeholder={"例如：\n3 年穿搭博主，真实测评无广\n155cm / 110 斤，微胖梨形身材"}
            />
          </Form.Item>
          <Form.Item label="内容边界（不涉及的领域、不使用的表达）">
            <TextArea
              rows={2}
              value={kb.content_boundary}
              onChange={(e) => setKb({ ...kb, content_boundary: e.target.value })}
              placeholder="例如：不做医疗功效断言；不使用「最」「第一」等绝对化用语"
            />
          </Form.Item>
          <Button type="primary" loading={saving} onClick={() => void handleSave()}>
            保存知识库
          </Button>

          {kb.lessons_learned.length > 0 && (
            <div style={{ marginTop: 16 }}>
              <Text strong>闭环学习经验（A-06）</Text>
              <List
                size="small"
                dataSource={kb.lessons_learned}
                renderItem={(lesson) => (
                  <List.Item>
                    <Tag color="blue">经验</Tag>
                    <Text>{lesson}</Text>
                  </List.Item>
                )}
              />
            </div>
          )}

          <DividerLabel label={`风格模仿样本（${samples.length}/5，C-07 Few-shot）`} />
          <Space style={{ marginBottom: 12 }}>
            <Button onClick={() => void loadLibraryNotes()}>选择内容库笔记</Button>
            {libraryNotes.length > 0 && (
              <Space>
                <select
                  value={pickedNoteId ?? ""}
                  onChange={(e) => setPickedNoteId(e.target.value ? Number(e.target.value) : null)}
                  style={{ width: 240 }}
                >
                  <option value="">请选择笔记</option>
                  {libraryNotes.map((note) => (
                    <option key={note.id} value={note.id}>
                      {note.id} - {note.title || "(无标题)"}
                    </option>
                  ))}
                </select>
                <Button type="primary" loading={analyzing} onClick={() => void handlePickAnalyze()}>
                  分析并加入
                </Button>
              </Space>
            )}
          </Space>
          <List
            size="small"
            dataSource={samples}
            locale={{ emptyText: "暂无风格样本，从内容库挑选 ≥5 篇历史优质笔记效果最佳" }}
            renderItem={(sample) => (
              <List.Item
                actions={[
                  <Popconfirm key="del" title="确认删除该样本？" onConfirm={() => void handleDeleteSample(sample.id)}>
                    <Button size="small" danger>
                      删除
                    </Button>
                  </Popconfirm>,
                ]}
              >
                <List.Item.Meta
                  title={sample.title || "(无标题)"}
                  description={
                    sample.style_analysis ? (
                      <Text type="secondary" style={{ whiteSpace: "pre-wrap" }}>
                        风格分析：{sample.style_analysis}
                      </Text>
                    ) : (
                      <Text type="secondary">未做风格分析</Text>
                    )
                  }
                />
              </List.Item>
            )}
          />
        </Form>
      )}
    </Card>
  );
}

function DividerLabel({ label }: { label: string }) {
  return (
    <div style={{ margin: "16px 0 8px", borderTop: "1px dashed #e8e8e8", paddingTop: 12 }}>
      <Text strong>{label}</Text>
    </div>
  );
}

// ---------- 用量统计（S-06）与账号健康（A-03）----------

function UsageAndHealthCards() {
  const auth = useAuth();
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [health, setHealth] = useState<AccountHealth[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const [usageRes, healthRes] = await Promise.all([fetchUsageSummary(7), fetchAccountHealth()]);
        setUsage(usageRes);
        setHealth(healthRes.items);
      } catch {
        // 单个板块失败不影响页面
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <>
      <Card
        title={
          <span>
            <ThunderboltOutlined style={{ marginRight: 8, color: "#faad14" }} />
            AI 用量统计（近 7 天）
          </span>
        }
        extra={<Text type="secondary">角色：{auth.user?.role === "admin" ? "管理员" : auth.user?.role === "user" ? "普通用户" : "-"}</Text>}
      >
        {!usage || loading ? (
          <Text type="secondary">加载中…</Text>
        ) : (
          <Table
            rowKey="model"
            size="small"
            pagination={false}
            dataSource={usage.by_model}
            summary={() => (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0}><Text strong>合计</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={1}><Text strong>{usage.total_calls}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={2}><Text strong>{usage.total_prompt_tokens.toLocaleString()}</Text></Table.Summary.Cell>
                <Table.Summary.Cell index={3}><Text strong>{usage.total_completion_tokens.toLocaleString()}</Text></Table.Summary.Cell>
              </Table.Summary.Row>
            )}
            columns={[
              { title: "模型", dataIndex: "model" },
              { title: "调用次数", dataIndex: "calls", width: 120 },
              { title: "输入 Token", dataIndex: "promptTokens", width: 140, render: (v: number) => v.toLocaleString() },
              { title: "输出 Token", dataIndex: "completionTokens", width: 140, render: (v: number) => v.toLocaleString() },
            ]}
          />
        )}
      </Card>

      <Card
        title={
          <span>
            <LineChartOutlined style={{ marginRight: 8, color: "#1677ff" }} />
            账号健康诊断
          </span>
        }
      >
        <Table<AccountHealth>
          rowKey="account_id"
          size="small"
          loading={loading}
          pagination={false}
          dataSource={health}
          locale={{ emptyText: "暂无小红书账号" }}
          columns={[
            { title: "账号", dataIndex: "nickname" },
            { title: "类型", dataIndex: "sub_type", width: 90, render: (v: string) => (v === "creator" ? "创作者" : "PC") },
            {
              title: "健康分",
              dataIndex: "score",
              width: 110,
              render: (score: number, record) => (
                <Space>
                  <Text strong style={{ color: score >= 60 ? "#52c41a" : score >= 40 ? "#faad14" : "#ff4d4f" }}>{score}</Text>
                  <Tag color={record.level === "healthy" ? "green" : record.level === "normal" ? "blue" : record.level === "attention" ? "orange" : "red"}>
                    {record.level_label}
                  </Tag>
                </Space>
              ),
            },
            {
              title: "近30天发布 / 平均互动",
              dataIndex: "stats",
              width: 190,
              render: (stats: AccountHealth["stats"]) => `${stats.published_30d} 条 / ${stats.avg_engagement}`,
            },
            {
              title: "诊断要点",
              dataIndex: "factors",
              ellipsis: true,
              render: (factors: string[]) => <Text type="secondary">{factors.join("；")}</Text>,
            },
          ]}
        />
      </Card>
    </>
  );
}

export default function SettingsPage() {
  return (
    <div>
      <PageHeader
        eyebrow="Workspace"
        title="设置"
        description="用户空间、安全、文件存储和系统参数会集中在这里。"
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24}>
          <KnowledgeBaseCard />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24}>
          <UsageAndHealthCards />
        </Col>
      </Row>

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <Card
            title={<span><SafetyCertificateOutlined style={{ marginRight: 8 }} />安全边界</span>}
          >
            <Paragraph>
              所有资源将通过平台用户和平台账号双重归属校验。Cookie 与模型 Key 由后端统一加密存储。
            </Paragraph>
          </Card>
        </Col>

        <Col xs={24} lg={12}>
          <Card
            title={<span><WarningOutlined style={{ marginRight: 8, color: "#faad14" }} />项目声明</span>}
          >
            <Paragraph>
              <ul style={{ paddingLeft: 20, margin: 0 }}>
                <li><Text strong>禁止任何形式的商业化使用</Text>，包括但不限于出售、转卖、收费服务</li>
                <li><Text strong>禁止用于任何违法违规活动</Text>，包括但不限于数据贩卖、恶意爬取、侵犯隐私</li>
                <li>使用者需自行承担因使用本项目产生的一切法律责任</li>
                <li>请遵守小红书平台的用户协议和相关法律法规</li>
              </ul>
            </Paragraph>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
