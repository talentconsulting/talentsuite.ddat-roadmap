FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=3000

WORKDIR /app

# No npm dependencies, so there's nothing to install.
COPY package.json ./
COPY lib ./lib
COPY scripts ./scripts
COPY public ./public
COPY server.js ./
COPY data ./data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:'+process.env.PORT+'/api/families').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
