#!/bin/bash

# Install OpenCode
curl -fsSL https://opencode.ai/install | bash
export PATH="$HOME/.opencode/bin:$PATH"
echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> ~/.bashrc
echo 'export PATH="$HOME/.opencode/bin:$PATH"' >> ~/.zshrc
