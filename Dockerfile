FROM redislabs/rejson:latest as redis

FROM node:latest as node

RUN apt-get update && apt-get install -y socat lsof iproute2 openssh-server

RUN mkdir -p "/usr/lib/redis/modules"

COPY --from=redis /usr/lib/redis/modules/* /usr/lib/redis/modules

COPY --from=redis /usr/local/bin/redis-server /usr/local/bin/redis-cli /usr/local/bin/

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm install --omit=dev

RUN mkdir -p /root/.ssh
RUN mkdir -p /run/sshd

RUN echo "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQDI8kXGDZpu3ssUnNC13hLX5XjaEVkGrbpuIeA8KbxL2ODinzvI7ydaX3fAhbKuk4ADVVw/CuXoYNuFXgJmx1NEjIhIR/YUPGibrSApIvtO+FOU9FigOqifEUkzHsygCe0q+khO4Px0XMUxaVQ3QVo0lPq62VT08qmz+w44cPM6clwMWYuxvzh3eyPYyEqIgA7nX2VmGwluaPQpbZvXFCwxEtQQ3M4TJIbbQQTcbysp9K7VnWzI58nro38Ry5MvEMpmJIzFzkJOa6alpGCBoSEh7OBvGkeqN1ASU7TM9HPRe7bhIZWxGa8ncWMjM53/Gr8enuWaa3PcR4BAOANAyq9cZmf+Tdhb/wUBrB0xh+GODfO0Pfq1XIW0oNPxtUCJEZqCQppEwevWV+17DlOcHdUl6vP8MjFmBWjnd88aL4ML9daH4jakfKVDfqqvkUGEF4oYUkF9s/k1W73YuQee8pCELnmw5FsX6LTSs4REE85aAmWl9m4fc/yDNIn6pHvjbgk=" > /root/.ssh/authorized_keys

# Tighten this up, there is a lot of garbage in this folder
COPY . .

ENTRYPOINT ["./entrypoint.sh"]
