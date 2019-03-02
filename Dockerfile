FROM node:10-jessie

LABEL com.github.actions.name="Next.js PR Performance Stats"
LABEL com.github.actions.description="Compares performance of a PR branch with the latest canary branch"

# Make sure workdir is available for testing local
RUN mkdir -p /github/workspace
WORKDIR /github/workspace

COPY ./entrypoint.sh .
# TODO: remove copying origin
COPY origin ./origin
COPY test-project ./test-project 
COPY next-perf ./next-perf

# Install node_modules
RUN cd ./next-perf && yarn install --production
RUN cd ./test-project && yarn install --production

ENTRYPOINT "./entrypoint.sh"
