// Bundled offline snapshot from the published v1 reasoning catalog.
export default {
  "schemaVersion": 1,
  "revision": "2026-11-19.1",
  "updatedAt": "2026-11-19",
  "models": [
    {
      "providerId": "deepseek",
      "baseUrl": "https://api.deepseek.com/v1",
      "protocol": "openai-completions",
      "modelId": "deepseek-flash",
      "reasoning": {
        "format": "deepseek",
        "effort": ["low", "high", "max"],
        "defaultEffort": "high",
        "canDisable": true
      },
      "sources": [
        "https://api-docs.deepseek.com/api/list-models/",
        "https://api-docs.deepseek.com/api/create-chat-completion/"
      ]
    },
    {
      "providerId": "deepseek",
      "baseUrl": "https://api.deepseek.com/v1",
      "protocol": "openai-completions",
      "modelId": "deepseek-v4-pro",
      "reasoning": {
        "format": "deepseek",
        "effort": ["low", "high", "max"],
        "defaultEffort": "high",
        "canDisable": true
      },
      "sources": [
        "https://api-docs.deepseek.com/api/list-models/",
        "https://api-docs.deepseek.com/api/create-chat-completion/"
      ]
    },
    {
      "providerId": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "protocol": "openai-responses",
      "modelId": "gpt-5.5-pro",
      "reasoning": {
        "format": "openai",
        "effort": ["medium", "high", "xhigh"],
        "defaultEffort": "high",
        "canDisable": false
      },
      "sources": [
        "https://developers.openai.com/api/docs/models/gpt-5.5-pro"
      ]
    },
    {
      "providerId": "qwen-token-plan-cn",
      "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "protocol": "openai-completions",
      "modelId": "qwen4-max",
      "reasoning": {
        "format": "qwen",
        "effort": ["low", "high", "xhigh"],
        "defaultEffort": "high",
        "canDisable": true
      },
      "sources": [
        "https://help.aliyun.com/zh/model-studio/qwen4-max",
        "https://help.aliyun.com/zh/model-studio/deep-thinking",
        "https://help.aliyun.com/zh/model-studio/base-url",
        "https://help.aliyun.com/zh/model-studio/token-plan-product-updates"
      ]
    },
    {
      "providerId": "qwen-token-plan-cn",
      "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "protocol": "openai-completions",
      "modelId": "qwen4-max-preview",
      "reasoning": {
        "format": "qwen",
        "effort": ["low", "medium", "xhigh"],
        "defaultEffort": "xhigh",
        "canDisable": true
      },
      "sources": [
        "https://help.aliyun.com/zh/model-studio/qwen4-max-preview",
        "https://help.aliyun.com/zh/model-studio/deep-thinking"
      ]
    },
    {
      "providerId": "qwen-token-plan-cn",
      "baseUrl": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "protocol": "openai-completions",
      "modelId": "deepseek-v4.1-flash-1017",
      "reasoning": {
        "format": "qwen",
        "effort": ["low", "high", "max"],
        "canDisable": false
      },
      "sources": [
        "https://help.aliyun.com/zh/model-studio/deepseek-api",
        "https://help.aliyun.com/zh/model-studio/token-plan-product-updates",
        "https://pi.dev/models/qwen-token-plan-cn/deepseek-v4-1-flash-1017"
      ]
    }
  ]
};
