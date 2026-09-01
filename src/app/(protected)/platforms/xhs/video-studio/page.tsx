"use client";
/**
 * 视频工坊：视频素材库 + 小红书规格体检 + 封面提取 + 转码适配
 * 对标小红书创作者中心创作辅助，定位为「发布前检测与适配工具」（非剪辑软件）
 */
import {
  CheckCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  DownloadOutlined,
  ExclamationCircleOutlined,
  InboxOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  RobotOutlined,
  SafetyCertificateOutlined,
  SendOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Input,
  InputNumber,
  Row,
  Space,
  Spin,
  Tag,
  Typography,
  Upload,
} from "antd";
import { useEffect, useState } from "react";
import Link from "next/link";

import { PageHeader } from "@/components/layout/app-shell";
import {
  addDraftAsset,
  createDraftFromNote,
  deleteUserVideo,
  detectVideo,
  extractVideoCover,
  fetchUserVideos,
  generateNoteWithAi,
  transcodeVideo,
  uploadAssetFile,
} from "@/lib/api";
import type { Draft, UserVideoFile, VideoDetectResult, VideoTranscodeResult } from "@/types";

const { Text, Paragraph } = Typography;
const { Dragger } = Upload;

/** 时长格式化（毫秒 → mm:ss 或 hh:mm:ss） */
function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** 文件大小格式化 */
function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export default function XhsVideoStudioPage() {
  const [videos, setVideos] = useState<UserVideoFile[]>([]);
  const [selected, setSelected] = useState<UserVideoFile | null>(null);
  const [detection, setDetection] = useState<VideoDetectResult | null>(null);
  const [coverPositionSec, setCoverPositionSec] = useState(0);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);
  const [coverFileName, setCoverFileName] = useState<string | null>(null);
  const [transcodeResult, setTranscodeResult] = useState<VideoTranscodeResult | null>(null);
  const [aiTopic, setAiTopic] = useState("");
  const [aiDraft, setAiDraft] = useState<Draft | null>(null);
  const [sentDraftId, setSentDraftId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isDetecting, setIsDetecting] = useState(false);
  const [isCovering, setIsCovering] = useState(false);
  const [isTranscoding, setIsTranscoding] = useState(false);
  const [isGeneratingNote, setIsGeneratingNote] = useState(false);
  const [isSendingToDraft, setIsSendingToDraft] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadVideos() {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fetchUserVideos();
      setVideos(result.items);
    } catch {
      setError("视频素材加载失败。");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadVideos();
  }, []);

  /** 选择素材并重置处理结果（保留已生成的文案，便于发送到草稿时联动） */
  function selectVideo(video: UserVideoFile) {
    setSelected(video);
    setDetection(null);
    setCoverPreview(null);
    setCoverFileName(null);
    setTranscodeResult(null);
    setSentDraftId(null);
    setAiTopic(video.file_name.replace(/\.[^.]+$/, ""));
  }

  /** 复制文本到剪贴板 */
  async function copyText(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMessage("已复制到剪贴板。");
    } catch {
      setError("复制失败，请手动选择复制。");
    }
  }

  async function handleUploadFile(file: File) {
    try {
      const uploaded = await uploadAssetFile(file);
      const newItem: UserVideoFile = {
        file_name: uploaded.file_name,
        url: uploaded.download_url,
        size: uploaded.size,
        source: "upload",
      };
      setVideos((prev) => [newItem, ...prev]);
      selectVideo(newItem);
      setMessage("视频上传成功，正在自动检测规格...");
      await runDetect(newItem.file_name);
    } catch {
      setError("文件上传失败，请确认文件不超过 500MB。");
    }
    return false; // 阻止 antd 自动上传
  }

  async function runDetect(fileName: string) {
    if (!fileName) return;
    setIsDetecting(true);
    setError(null);
    setMessage(null);
    try {
      const result = await detectVideo({ file_name: fileName });
      setDetection(result);
    } catch {
      setError("规格检测失败，请确认本机已安装 ffmpeg 且文件为有效视频。");
    } finally {
      setIsDetecting(false);
    }
  }

  async function handleCover() {
    if (!selected) return;
    setIsCovering(true);
    setError(null);
    setMessage(null);
    try {
      const result = await extractVideoCover({
        file_name: selected.file_name,
        position_ms: Math.round(coverPositionSec * 1000),
      });
      setCoverPreview(result.download_url);
      setCoverFileName(result.file_name);
      setMessage("封面提取成功，可点击下载保存。");
    } catch {
      setError("封面提取失败，请确认本机已安装 ffmpeg。");
    } finally {
      setIsCovering(false);
    }
  }

  async function handleTranscode() {
    if (!selected) return;
    setIsTranscoding(true);
    setError(null);
    setMessage(null);
    try {
      const result = await transcodeVideo({ file_name: selected.file_name });
      setTranscodeResult(result);
      const newItem: UserVideoFile = {
        file_name: result.file_name,
        url: result.download_url,
        size: result.metadata?.sizeBytes ?? 0,
        source: "transcode",
      };
      setVideos((prev) => [newItem, ...prev]);
      setMessage("转码完成，产物已加入素材库。");
    } catch {
      setError("转码失败，请确认本机已安装 ffmpeg 且文件有效。");
    } finally {
      setIsTranscoding(false);
    }
  }

  async function handleDelete(video: UserVideoFile) {
    try {
      await deleteUserVideo(video.file_name);
      setVideos((prev) => prev.filter((v) => v.file_name !== video.file_name));
      if (selected?.file_name === video.file_name) {
        setSelected(null);
        setDetection(null);
        setCoverPreview(null);
        setTranscodeResult(null);
        setAiDraft(null);
        setSentDraftId(null);
      }
    } catch {
      /* 全局拦截器提示错误 */
    }
  }

  /** AI 生成视频笔记文案（generate-note 自动建草稿，文案草稿与视频联动发送） */
  async function handleGenerateNote() {
    if (!aiTopic.trim()) {
      setError("请填写视频主题。");
      return;
    }
    setIsGeneratingNote(true);
    setError(null);
    setMessage(null);
    try {
      const draft = await generateNoteWithAi({
        platform: "xhs",
        topic: aiTopic.trim(),
        instruction: "为小红书视频笔记撰写文案，突出视频内容亮点，语气自然有网感，标题 20 字以内。",
      });
      setAiDraft(draft);
      setMessage("视频文案已生成并保存为草稿，可点击「发送到草稿工坊」挂载视频素材。");
    } catch {
      setError("文案生成失败，请确认已配置文本生成模型。");
    } finally {
      setIsGeneratingNote(false);
    }
  }

  /** 一键发送到草稿工坊：有文案草稿则挂载素材，否则新建草稿 */
  async function handleSendToDraft() {
    if (!selected) return;
    setIsSendingToDraft(true);
    setError(null);
    setMessage(null);
    try {
      let draft = aiDraft;
      if (!draft) {
        draft = await createDraftFromNote({ platform: "xhs" });
      }
      await addDraftAsset(draft.id, {
        asset_type: "video",
        url: `/api/files/media/${selected.file_name}`,
        local_path: selected.file_name,
      });
      setSentDraftId(draft.id);
      setMessage(`视频素材已发送到草稿工坊（草稿 #${draft.id}）。`);
    } catch {
      setError("发送到草稿失败，请稍后重试。");
    } finally {
      setIsSendingToDraft(false);
    }
  }

  return (
    <div>
      <PageHeader
        eyebrow="XHS Video Studio"
        title="视频工坊"
        description="视频素材管理、小红书规格体检、封面提取与转码适配，为发布做准备。"
        action={
          <Button icon={<ReloadOutlined />} onClick={loadVideos} loading={isLoading}>
            刷新素材
          </Button>
        }
      />

      {error && (
        <Alert type="error" message={error} showIcon closable onClose={() => setError(null)} style={{ marginBottom: 16 }} />
      )}
      {message && (
        <Alert type="success" message={message} showIcon closable onClose={() => setMessage(null)} style={{ marginBottom: 16 }} />
      )}

      {/* ---- 顶部：选中素材的检测结果与处理工具 ---- */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {/* 左卡：规格体检 */}
        <Col xs={24} md={14}>
          <Card
            title={
              <Space>
                <SafetyCertificateOutlined /> 小红书规格体检
              </Space>
            }
            extra={
              selected ? (
                <Space>
                  <Text type="secondary" style={{ fontSize: 11, maxWidth: 160 }} ellipsis>
                    {selected.file_name}
                  </Text>
                  <Button size="small" icon={<ReloadOutlined />} loading={isDetecting} onClick={() => void runDetect(selected.file_name)}>
                    重新检测
                  </Button>
                </Space>
              ) : (
                <Text type="secondary" style={{ fontSize: 11 }}>先在下方案材库选择一个视频</Text>
              )
            }
          >
            {!selected ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="请从素材库选择视频后开始检测" style={{ padding: 24 }} />
            ) : isDetecting ? (
              <div style={{ textAlign: "center", padding: 24 }}>
                <Spin tip="正在解析视频规格..." />
              </div>
            ) : !detection ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未检测，点击「重新检测」开始" style={{ padding: 24 }} />
            ) : (
              <div>
                <Descriptions
                  size="small"
                  column={{ xs: 2, sm: 2, md: 3 }}
                  items={[
                    { key: "duration", label: "时长", children: formatDuration(detection.durationMs) },
                    { key: "resolution", label: "分辨率", children: `${detection.width}x${detection.height}` },
                    { key: "fps", label: "帧率", children: `${detection.fps.toFixed(1)} fps` },
                    { key: "format", label: "封装", children: detection.format || "-" },
                    { key: "videoCodec", label: "视频编码", children: detection.videoCodec || "-" },
                    { key: "audioCodec", label: "音频编码", children: detection.audioCodec || "-" },
                    { key: "size", label: "大小", children: formatSize(detection.sizeBytes) },
                  ]}
                  style={{ marginBottom: 12 }}
                />
                <div style={{ marginBottom: 8 }}>
                  {detection.compliance.passed ? (
                    <Tag color="green" icon={<CheckCircleOutlined />}>符合发布规格</Tag>
                  ) : (
                    <Tag color="red" icon={<ExclamationCircleOutlined />}>存在需处理项</Tag>
                  )}
                </div>
                {detection.compliance.items.map((item) => (
                  <Alert
                    key={item.key}
                    type={item.level === "error" ? "error" : "warning"}
                    message={item.message}
                    showIcon
                    icon={item.level === "error" ? <ExclamationCircleOutlined /> : <WarningOutlined />}
                    style={{ marginBottom: 8 }}
                  />
                ))}
              </div>
            )}
          </Card>
        </Col>

        {/* 右卡：封面提取 + 转码 */}
        <Col xs={24} md={10}>
          <Card
            title={
              <Space>
                <PlayCircleOutlined /> 封面提取与转码
              </Space>
            }
          >
            <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: "block" }}>
              封面提取（默认首帧，可指定时间点）
            </Text>
            <Space.Compact style={{ width: "100%", marginBottom: 8 }}>
              <InputNumber
                value={coverPositionSec}
                onChange={(v) => setCoverPositionSec(v ?? 0)}
                min={0}
                max={600}
                precision={0}
                addonBefore="时间点"
                addonAfter="秒"
                style={{ width: "100%" }}
                disabled={!selected || isCovering}
              />
              <Button
                type="primary"
                icon={<PlayCircleOutlined />}
                loading={isCovering}
                disabled={!selected}
                onClick={() => void handleCover()}
              >
                提取
              </Button>
            </Space.Compact>
            {coverPreview && (
              <div style={{ background: "#f2f2f2", borderRadius: 6, padding: 8, textAlign: "center", marginBottom: 12 }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={coverPreview} alt="封面预览" style={{ maxHeight: 140, borderRadius: 4 }} />
                <div style={{ marginTop: 6 }}>
                  <Button size="small" icon={<DownloadOutlined />} href={coverPreview} download={coverFileName ?? "cover.jpg"}>
                    下载封面
                  </Button>
                </div>
              </div>
            )}

            <Text type="secondary" style={{ fontSize: 12, marginBottom: 8, display: "block" }}>
              转码适配（非 H.264 / 非 MP4 视频发布前请转码）
            </Text>
            <Button
              icon={<ReloadOutlined />}
              loading={isTranscoding}
              disabled={!selected}
              onClick={() => void handleTranscode()}
              block
            >
              转码为 H.264 MP4
            </Button>
            {transcodeResult && (
              <div style={{ marginTop: 8 }}>
                <Text type="secondary" style={{ fontSize: 12, display: "block" }}>转码产物</Text>
                <Space style={{ marginTop: 4 }}>
                  <Button size="small" type="link" icon={<DownloadOutlined />} href={transcodeResult.download_url} download={transcodeResult.file_name}>
                    下载 {transcodeResult.file_name}
                  </Button>
                  {transcodeResult.metadata && (
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {formatDuration(transcodeResult.metadata.durationMs)} · {transcodeResult.metadata.width}x{transcodeResult.metadata.height} · {formatSize(transcodeResult.metadata.sizeBytes)}
                    </Text>
                  )}
                </Space>
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* ---- 中部：AI 视频文案 + 发送到草稿 ---- */}
      <Row gutter={[16, 16]} style={{ marginBottom: 24 }}>
        {/* 左卡：AI 视频文案 */}
        <Col xs={24} md={14}>
          <Card
            title={
              <Space>
                <RobotOutlined /> AI 视频文案
              </Space>
            }
            extra={
              <Text type="secondary" style={{ fontSize: 11 }}>
                需配置文本生成模型
              </Text>
            }
          >
            <Space.Compact style={{ width: "100%", marginBottom: 12 }}>
              <Input
                value={aiTopic}
                onChange={(e) => setAiTopic(e.target.value)}
                placeholder="视频主题（默认取文件名）"
                onPressEnter={() => void handleGenerateNote()}
                disabled={isGeneratingNote}
              />
              <Button
                type="primary"
                icon={<RobotOutlined />}
                loading={isGeneratingNote}
                onClick={() => void handleGenerateNote()}
              >
                生成文案
              </Button>
            </Space.Compact>
            {aiDraft && (
              <div>
                <div style={{ background: "#fafafa", borderRadius: 6, padding: 12, marginBottom: 8 }}>
                  <Text strong style={{ fontSize: 13, display: "block", marginBottom: 8 }}>
                    {aiDraft.title}
                  </Text>
                  <Paragraph
                    style={{ fontSize: 13, margin: 0, whiteSpace: "pre-wrap", maxHeight: 220, overflowY: "auto" }}
                  >
                    {aiDraft.body}
                  </Paragraph>
                </div>
                <Space>
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={() => void copyText(`${aiDraft.title}\n\n${aiDraft.body}`)}
                  >
                    复制文案
                  </Button>
                  <Text type="secondary" style={{ fontSize: 11 }}>
                    文案已自动保存为草稿（# {aiDraft.id}），发送视频时将一并挂载
                  </Text>
                </Space>
              </div>
            )}
          </Card>
        </Col>

        {/* 右卡：发送到草稿工坊 */}
        <Col xs={24} md={10}>
          <Card
            title={
              <Space>
                <SendOutlined /> 发送到草稿工坊
              </Space>
            }
          >
            {!selected ? (
              <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="先选择要发送的视频素材" style={{ padding: 16 }} />
            ) : (
              <div>
                <Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 12 }}>
                  将 {selected.file_name} 发送到草稿工坊
                  {aiDraft ? "（联动已生成的文案）" : "（生成文案后将一并带入）"}
                </Text>
                <Button
                  type="primary"
                  block
                  icon={<SendOutlined />}
                  loading={isSendingToDraft}
                  onClick={() => void handleSendToDraft()}
                >
                  发送到草稿工坊
                </Button>
                {sentDraftId && (
                  <div style={{ marginTop: 12, textAlign: "center" }}>
                    <Text type="success" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
                      已发送（草稿 #{sentDraftId}）
                    </Text>
                    <Link href="/platforms/xhs/drafts">
                      <Button size="small" type="link">前往草稿工坊继续编辑</Button>
                    </Link>
                  </div>
                )}
              </div>
            )}
          </Card>
        </Col>
      </Row>

      {/* ---- 底部：视频素材库 ---- */}
      <Card
        title={
          <Space>
            <PlayCircleOutlined /> 视频素材库
          </Space>
        }
      >
        <Dragger
          accept="video/*"
          multiple
          showUploadList={false}
          beforeUpload={(file) => {
            void handleUploadFile(file);
            return false;
          }}
          style={{ marginBottom: 16 }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">拖入视频文件，或点击上传</p>
          <p className="ant-upload-hint">支持 MP4/MOV/AVI/MKV，单文件上限 500MB，可多选</p>
        </Dragger>
        {isLoading ? (
          <div style={{ textAlign: "center", padding: 48 }}>
            <Spin tip="正在加载视频素材..." />
          </div>
        ) : videos.length === 0 ? (
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="暂无视频素材。上传视频后将显示在这里，支持 MP4/MOV/AVI/MKV，上限 500MB。"
            style={{ padding: 32 }}
          />
        ) : (
          <Row gutter={[12, 12]}>
            {videos.map((video) => (
              <Col xs={24} sm={12} md={8} lg={6} key={video.file_name}>
                <Card
                  size="small"
                  hoverable
                  styles={{ body: { padding: 8 } }}
                  style={selected?.file_name === video.file_name ? { borderColor: "#386bff" } : undefined}
                  onClick={() => selectVideo(video)}
                >
                  <div
                    style={{
                      height: 120,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      marginBottom: 6,
                      overflow: "hidden",
                      borderRadius: 4,
                      background: "#f2f2f2",
                    }}
                  >
                    <video src={video.url} muted preload="metadata" style={{ maxHeight: 120, maxWidth: "100%" }} />
                  </div>
                  <Text strong ellipsis style={{ fontSize: 12, display: "block" }}>
                    {video.file_name}
                  </Text>
                  <div style={{ marginTop: 4 }}>
                    <Tag color={video.source === "transcode" ? "purple" : "blue"} style={{ fontSize: 10, padding: "0 4px", margin: 0 }}>
                      {video.source === "transcode" ? "转码产物" : "上传素材"}
                    </Tag>
                    <Text type="secondary" style={{ fontSize: 10, marginLeft: 4 }}>
                      {formatSize(video.size)}
                    </Text>
                  </div>
                  <Button
                    type="text"
                    danger
                    size="small"
                    icon={<DeleteOutlined />}
                    onClick={(e) => { e.stopPropagation(); void handleDelete(video); }}
                    style={{ width: "100%", marginTop: 4 }}
                  >
                    删除
                  </Button>
                </Card>
              </Col>
            ))}
          </Row>
        )}
      </Card>
    </div>
  );
}
