FROM node:10-jessie

LABEL com.github.actions.name="Next.js PR Performance Stats"
LABEL com.github.actions.description="Compares performance of a PR branch with the latest canary branch"

# Make sure workdir is available
RUN mkdir -p /github/workspace
WORKDIR /github/workspace

COPY ./entrypoint.sh .
COPY test-project ./test-project 
COPY get-stats ./get-stats

# Install node_modules
RUN cd ./get-stats && yarn install --production
RUN cd ./test-project && yarn install --production

ENTRYPOINT "./entrypoint.sh"
