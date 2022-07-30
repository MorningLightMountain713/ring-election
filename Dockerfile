FROM redislabs/rejson:latest as redis

FROM node:latest as node

RUN mkdir -p "/usr/lib/redis/modules"

COPY --from=redis /usr/lib/redis/modules/* /usr/lib/redis/modules

COPY --from=redis /usr/local/bin/redis-server /usr/local/bin/redis-cli /usr/local/bin/

# Create app directory
WORKDIR /usr/src/app

# Install app dependencies
# A wildcard is used to ensure both package.json AND package-lock.json are copied
# where available (npm@5+)
COPY package*.json ./

#RUN npm install
# If you are building your code for production
RUN npm install --only=production

# Bundle app source
COPY . .

EXPOSE 3000 8080
ENTRYPOINT [ "sh" , "./entrypoint.sh" ]
