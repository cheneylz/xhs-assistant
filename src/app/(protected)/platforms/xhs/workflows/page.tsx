"use client";
import {
  ApartmentOutlined,
  PlayCircleOutlined,
  PlusOutlined,
  ReloadOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  List,
  Modal,
  Popconfirm,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";

import { PageHeader } from "@/components/layout/app-shell";
import { createSkill, deleteSkill, fetchSkills, fetchWorkflowRuns, fetchWorkflows, runWorkflow, updateSkill } from "@/lib/api";
import { formatShanghaiTime } from "@/lib/time";
import type { SkillItem, WorkflowDef, WorkflowRunRecord, WorkflowRunResult } from "@/types";

const { Text, Paragraph } = Typography;

/** 新建技能的 SKILL.md 模板（标准 Agent SKILL 格式：frontmatter + Markdown 指令正文） */
const SKILL_MD_TEMPLATE = `---
name: 技能名称
description: 一句话描述技能用途
---

# 技能名称

在此编写技能指令正文（Markdown），说明技能用途、执行步骤与输出格式。`;

const WORKFLOW_STATUS: Record<string, { color: string; label: string }> = {
  completed: { color: "green", label: "已完成" },
  failed: { color: "red", label: "失败" },
  running: { color: "processing", label: "运行中" },
};

/** 工作流编排页（AI Agent 平台 S-04/S-03）：预置工作流执行 + 技能库 */
export default function WorkflowsPage() {
  const [workflows, setWorkflows] = useState<WorkflowDef[]>([]);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [runs, setRuns] = useState<WorkflowRunRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [runningKey, setRunningKey] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<WorkflowRunResult | null>(null);

  // 技能库管理（人工维护 SKILL）
  const [skillForm] = Form.useForm<{ skill_key: string; name: string; description: string; instructions: string }>();
  const [skillModal, setSkillModal] = useState<{ open: boolean; editing: SkillItem | null }>({ open: false, editing: null });
  const [savingSkill, setSavingSkill] = useState(false);

  async function loadAll() {
    setIsLoading(true);
    try {
      const [workflowRes, skillRes, runsRes] = await Promise.all([fetchWorkflows(), fetchSkills(), fetchWorkflowRuns()]);
      setWorkflows(workflowRes.items);
      setSkills(skillRes.items);
      setRuns(runsRes.items);
    } catch (error) {
      message.error(`加载失败: ${(error as Error).message}`);
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadAll();
  }, []);

  function openCreateSkill() {
    skillForm.setFieldsValue({ skill_key: "", name: "", description: "", instructions: SKILL_MD_TEMPLATE });
    setSkillModal({ open: true, editing: null });
  }

  function openEditSkill(skill: SkillItem) {
    skillForm.setFieldsValue({
      skill_key: skill.skill_key,
      name: skill.name,
      description: skill.description ?? "",
      instructions: skill.instructions ?? "",
    });
    setSkillModal({ open: true, editing: skill });
  }

  async function handleSaveSkill() {
    const values = await skillForm.validateFields();
    setSavingSkill(true);
    try {
      if (skillModal.editing) {
        await updateSkill(skillModal.editing.id, {
          name: values.name,
          description: values.description,
          instructions: values.instructions,
        });
        message.success(`技能「${values.name}」已更新`);
      } else {
        await createSkill({
          skill_key: values.skill_key,
          name: values.name,
          description: values.description,
          instructions: values.instructions,
        });
        message.success(`技能「${values.name}」已创建`);
      }
      setSkillModal({ open: false, editing: null });
      await loadAll();
    } catch (error) {
      message.error(`保存技能失败: ${(error as Error).message}`);
    } finally {
      setSavingSkill(false);
    }
  }

  async function handleDeleteSkill(skill: SkillItem) {
    try {
      await deleteSkill(skill.id);
      message.success(`技能「${skill.name}」已删除`);
      await loadAll();
    } catch (error) {
      message.error(`删除技能失败: ${(error as Error).message}`);
    }
  }

  async function handleToggleSkill(skill: SkillItem, enabled: boolean) {
    try {
      await updateSkill(skill.id, { enabled });
      message.success(`技能「${skill.name}」已${enabled ? "启用" : "停用"}`);
      await loadAll();
    } catch (error) {
      message.error(`更新技能状态失败: ${(error as Error).message}`);
    }
  }

  async function handleRun(workflow: WorkflowDef) {
    setRunningKey(workflow.workflow_key);
    setLastResult(null);
    try {
      const result = await runWorkflow(workflow.workflow_key);
      setLastResult(result);
      message.success(`工作流「${workflow.name}」执行${result.status === "completed" ? "完成" : "失败"}，详见结果面板`);
      await loadAll();
    } catch (error) {
      message.error(`工作流执行失败: ${(error as Error).message}`);
    } finally {
      setRunningKey(null);
    }
  }

  const runColumns: ColumnsType<WorkflowRunRecord> = [
    { title: "ID", dataIndex: "id", width: 70 },
    {
      title: "工作流",
      dataIndex: "payload",
      width: 180,
      render: (payload: Record<string, unknown>) => String(payload?.workflow_name ?? payload?.workflow_key ?? "-"),
    },
    {
      title: "状态",
      dataIndex: "status",
      width: 100,
      render: (status: string) => {
        const cfg = WORKFLOW_STATUS[status] ?? { color: "default", label: status };
        return <Tag color={cfg.color}>{cfg.label}</Tag>;
      },
    },
    { title: "进度", dataIndex: "progress", width: 80, render: (value: number) => `${value}%` },
    {
      title: "步骤",
      dataIndex: "steps",
      width: 220,
      render: (steps: Array<{ task_type: string; status: string }>) => (
        <Space wrap>
          {steps.map((step, index) => (
            <Tag key={index} color={step.status === "completed" ? "green" : step.status === "failed" ? "red" : "default"}>
              {String(step.task_type).replace("workflow_step:", "")}
            </Tag>
          ))}
        </Space>
      ),
    },
    { title: "时间", dataIndex: "created_at", width: 160, render: (value: string) => formatShanghaiTime(value) },
  ];

  return (
    <div>
      <PageHeader
        eyebrow="Workflow"
        title="工作流编排"
        description="预置工作流将多个技能串联为自动化任务管线，任务在任务中心可见。"
      />

      <Spin spinning={isLoading}>
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          {/* 预置工作流 */}
          <Card
            title={
              <span>
                <ApartmentOutlined style={{ marginRight: 8 }} />
                预置工作流
              </span>
            }
            extra={<Button icon={<ReloadOutlined />} onClick={() => void loadAll()}>刷新</Button>}
          >
            <List
              dataSource={workflows}
              locale={{ emptyText: "暂无工作流" }}
              renderItem={(workflow) => (
                <List.Item
                  actions={[
                    <Button
                      key="run"
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      loading={runningKey === workflow.workflow_key}
                      onClick={() => void handleRun(workflow)}
                    >
                      执行
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Space>
                        <Text strong>{workflow.name}</Text>
                        <Tag>{workflow.workflow_key}</Tag>
                      </Space>
                    }
                    description={
                      <div>
                        <Paragraph style={{ marginBottom: 4 }}>{workflow.description}</Paragraph>
                        <Space wrap>
                          {workflow.steps.map((step) => (
                            <Tag key={step.id} color="blue">
                              {step.name}
                            </Tag>
                          ))}
                        </Space>
                      </div>
                    }
                  />
                </List.Item>
              )}
            />
          </Card>

          {/* 执行结果 */}
          {lastResult && (
            <Card size="small" title={`执行结果：${lastResult.workflow_key}（${lastResult.status}）`}>
              <List
                size="small"
                dataSource={lastResult.steps}
                renderItem={(step) => (
                  <List.Item>
                    <List.Item.Meta
                      title={
                        <Space>
                          <Tag color={step.status === "completed" ? "green" : "red"}>{step.skill_key}</Tag>
                          <Text>{step.status === "completed" ? "完成" : "失败"}</Text>
                        </Space>
                      }
                      description={
                        step.status === "failed" ? (
                          <Text type="danger">{step.error}</Text>
                        ) : (
                          <Text type="secondary" style={{ whiteSpace: "pre-wrap" }}>
                            {JSON.stringify(step.output, null, 2)}
                          </Text>
                        )
                      }
                    />
                  </List.Item>
                )}
              />
            </Card>
          )}

          {/* 技能库 */}
          <Card
            size="small"
            title={
              <span>
                <ToolOutlined style={{ marginRight: 8 }} />
                技能库（S-03）
              </span>
            }
            extra={
              <Button type="primary" icon={<PlusOutlined />} onClick={openCreateSkill}>
                新增技能
              </Button>
            }
          >
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="技能采用标准 Agent SKILL 格式（name/description frontmatter + Markdown 指令正文），可人工新增、编辑、删除；预置技能由系统提供，自定义技能执行时以指令正文驱动 LLM。"
            />
            <Table<SkillItem>
              rowKey="id"
              size="small"
              pagination={false}
              locale={{ emptyText: "暂无技能" }}
              dataSource={skills}
              columns={[
                { title: "名称", dataIndex: "name", width: 140, render: (value: string, skill) => <Text strong>{value}</Text> },
                { title: "标识", dataIndex: "skill_key", width: 170, render: (value: string) => <Tag>{value}</Tag> },
                { title: "描述", dataIndex: "description", ellipsis: true },
                {
                  title: "启用",
                  dataIndex: "enabled",
                  width: 70,
                  render: (enabled: boolean, skill) => (
                    <Switch size="small" checked={enabled} onChange={(checked) => void handleToggleSkill(skill, checked)} />
                  ),
                },
                {
                  title: "操作",
                  width: 110,
                  render: (_, skill) => (
                    <Space>
                      <Button size="small" type="link" onClick={() => openEditSkill(skill)}>
                        编辑
                      </Button>
                      <Popconfirm title={`删除技能「${skill.name}」？`} onConfirm={() => void handleDeleteSkill(skill)}>
                        <Button size="small" type="link" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>

          {/* 技能编辑弹窗 */}
          <Modal
            title={skillModal.editing ? `编辑技能：${skillModal.editing.name}` : "新增技能"}
            open={skillModal.open}
            onOk={() => void handleSaveSkill()}
            onCancel={() => setSkillModal({ open: false, editing: null })}
            confirmLoading={savingSkill}
            width={680}
            okText="保存"
            cancelText="取消"
          >
            <Form form={skillForm} layout="vertical" initialValues={{ description: "", instructions: SKILL_MD_TEMPLATE }}>
              <Form.Item name="skill_key" label="技能标识（skill_key）" rules={[{ required: true, message: "请输入技能标识" }]}>
                <Input placeholder="如：content.rewrite" disabled={Boolean(skillModal.editing)} />
              </Form.Item>
              <Form.Item name="name" label="技能名称" rules={[{ required: true, message: "请输入技能名称" }]}>
                <Input placeholder="如：文案改写" />
              </Form.Item>
              <Form.Item name="description" label="描述" rules={[{ max: 500 }]}>
                <Input placeholder="一句话描述技能用途" />
              </Form.Item>
              <Form.Item
                name="instructions"
                label="指令正文（SKILL.md 格式）"
                rules={[{ required: true, message: "请输入指令正文" }]}
                extra="标准 Agent SKILL 格式：frontmatter（name/description）+ Markdown 指令正文。自定义技能执行时该内容作为 system prompt 驱动 LLM。"
              >
                <Input.TextArea rows={12} />
              </Form.Item>
            </Form>
          </Modal>

          {/* 最近运行记录 */}
          <Card size="small" title="最近运行记录">
            <Table<WorkflowRunRecord>
              rowKey="id"
              size="small"
              columns={runColumns}
              dataSource={runs}
              pagination={{ pageSize: 5 }}
              locale={{ emptyText: "暂无工作流执行记录" }}
            />
          </Card>
        </Space>
      </Spin>
    </div>
  );
}
