"use client";
import {
  ApartmentOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Collapse,
  List,
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
import { fetchSkills, fetchWorkflowRuns, fetchWorkflows, runWorkflow } from "@/lib/api";
import { formatShanghaiTime } from "@/lib/time";
import type { SkillItem, WorkflowDef, WorkflowRunRecord, WorkflowRunResult } from "@/types";

const { Text, Paragraph } = Typography;

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
          >
            <Space wrap>
              {skills.map((skill) => (
                <Tag key={skill.skill_key} color={skill.enabled ? "geekblue" : "default"}>
                  {skill.name}（{skill.skill_key}）
                </Tag>
              ))}
            </Space>
          </Card>

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
