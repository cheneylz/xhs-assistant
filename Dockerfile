# =====================================================
# xhs-assistant 应用镜像（Next.js standalone）
# 构建阶段：npm ci + prisma generate + next build
# 运行阶段：node server.js（签名 JS 文件与 prisma schema 随镜像携带）
# =====================================================
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 生成 Prisma client 并构建
RUN npx prisma generate && npm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# ffmpeg：视频元数据/封面抽取/转码依赖（发布链路与视频工坊共用）
RUN apk add --no-cache ffmpeg \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
# 签名 SDK 的 JS 文件与 Prisma 运行时（standalone 不含未引用文件，需显式拷贝）
COPY --from=builder --chown=nextjs:nodejs /app/src/lib/server/xhs/js ./src/lib/server/xhs/js
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

CMD ["node", "server.js"]
