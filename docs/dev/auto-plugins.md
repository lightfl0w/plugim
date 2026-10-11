# 自动注册插件

## 概述

`@plugim/core` 提供了基于 TypeScript 装饰器的自动插件注册功能。

## API

### `@AutoPlugin()`

装饰器标记类为自动注册的插件。

```typescript
import { AutoPlugin } from "@plugim/core";
import type { Plugin } from "@plugim/core";

@AutoPlugin()
export class MyPlugin implements Plugin {
    readonly name = "my-plugin";
    
    async apply(ctx) {
        ctx.provide("service", {});
        return undefined;
    }
}
```

### `autoDiscoverPlugins(ctx, classes)`

手动触发自动扫描和注册。

```typescript
const ctx = new Context();
await autoDiscoverPlugins(ctx, [MyPlugin]);
```

## 使用方式

### 1. 装饰器方式（推荐）

```typescript
@AutoPlugin()
export class ConfigPlugin implements Plugin {
    readonly name = "config";
    
    async apply(ctx) {
        ctx.provide("config", configService);
    }
}
```

### 2. 传统对象方式（仍然支持）

```typescript
export const ConfigPlugin: Plugin = {
    name: "config",
    async apply(ctx) {
        ctx.provide("config", configService);
    },
};
```

## 示例

完整示例请参考：
- `packages/core/src/examples.ts` - Core 包中的示例
- `apps/server/src/plugins/example-plugin.ts` - Server 包中的实际示例

## 编译配置

需要在 `tsconfig.base.json` 中添加装饰器支持：

```json
{
    "compilerOptions": {
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true
    }
}
```