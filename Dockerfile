FROM docker.1ms.run/library/node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
# 只有 ws 一个运行时依赖，不需要 devDependencies
RUN npm ci --omit=dev && npm cache clean --force

COPY index.js ./
COPY src ./src
COPY www ./www

EXPOSE 8081

# 健康检查：静态首页能正常返回即视为存活
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8081/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "index.js", "8081"]
