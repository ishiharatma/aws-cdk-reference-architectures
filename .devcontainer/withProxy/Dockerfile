ARG VARIANT="1-22-bookworm"
FROM mcr.microsoft.com/devcontainers/typescript-node:${VARIANT}

# Copy and update certificate
COPY .devcontainer/withProxy/YourRootCA.cer /usr/local/share/ca-certificates/YourRootCA.crt
RUN update-ca-certificates
# Configure SSL settings and specify certificate path for npm
RUN npm config --global set cafile /etc/ssl/certs/ca-certificates.crt \
    && npm config --global set registry http://registry.npmjs.org/ \
    && npm config --global set strict-ssl false \
    && git config --system http.sslCAInfo /usr/local/share/ca-certificates/YourRootCA.crt

ENV AWS_CA_BUNDLE=/usr/local/share/ca-certificates/YourRootCA.crt

# Install additional packages
RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get -y install --no-install-recommends \
    python3 \
    python3-pip \
    python3-venv \
    graphviz \
    jq \
    git \
    curl \
    unzip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Install AWS CLI v2 (architecture detection)
RUN ARCH=$(uname -m) && \
    if [ "$ARCH" = "x86_64" ]; then \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o "awscliv2.zip"; \
    elif [ "$ARCH" = "aarch64" ]; then \
    curl "https://awscli.amazonaws.com/awscli-exe-linux-aarch64.zip" -o "awscliv2.zip"; \
    fi && \
    unzip awscliv2.zip && \
    ./aws/install && \
    rm -rf aws awscliv2.zip

# Install AWS Session Manager Plugin
RUN export OS_CPU="" && \
    if [ $(uname -m) = "x86_64" ]; then \
    export OS_CPU="ubuntu_64bit"; \
    elif [ $(uname -m) = "aarch64" ]; then \
    export OS_CPU="ubuntu_arm64"; \
    fi && \
    if [ -n "$OS_CPU" ]; then \
    curl "https://s3.amazonaws.com/session-manager-downloads/plugin/latest/${OS_CPU}/session-manager-plugin.deb" \
    -o session-manager-plugin.deb && \
    apt-get update && \
    apt-get install -y ./session-manager-plugin.deb && \
    rm -rf ./session-manager-plugin.deb && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*; \
    else \
    echo "Unknown architecture for AWS Session Manager Plugin installation"; \
    fi

# Grant sudo privileges to node user
RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers.d/node

# install AWS CDK and TypeScript
RUN npm install -g aws-cdk aws-cdk-local typescript

# Set user to node
USER node
WORKDIR /home/node

# Configure certificate path for Git
# Reconfigure npm settings for node user (just in case)
RUN npm config set cafile /etc/ssl/certs/ca-certificates.crt \
    && npm config set registry https://registry.npmjs.org/ \
    && npm config set strict-ssl true \
    && git config --global http.sslCAInfo /usr/local/share/ca-certificates/YourRootCA.crt

# Install uv
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
# Add .local/bin to PATH
ENV PATH="/home/node/.local/bin:${PATH}"

# LocalStack CLI
RUN pip3 install --user awscli-local --break-system-packages

ARG LOCALSTACK_VERSION="4.9.1"
RUN export FILE="" && \
    if [ $(uname -m) = "x86_64" ]; then \
    export FILE="localstack-cli-${LOCALSTACK_VERSION}-linux-amd64-onefile.tar.gz"; \
    elif [ $(uname -m) = "aarch64" ]; then \
    export FILE="localstack-cli-${LOCALSTACK_VERSION}-linux-arm64-onefile.tar.gz"; \
    fi && \
    if [ -n "$FILE" ]; then \
    echo "v${LOCALSTACK_VERSION}/Downloading ${FILE}" && \
    curl --output "${FILE}" --location "https://github.com/localstack/localstack-cli/releases/download/v${LOCALSTACK_VERSION}/${FILE}" && \
    sudo tar xvzf "${FILE}" -C /usr/local/bin && \
    rm "${FILE}"; \
    fi

# Set PATH for container startup
ENV PATH="/home/node/.local/bin:${PATH}"