/**
 * Extension 端 action 输入 zod schema 集中定义
 *
 * 每个 action handler 入口用对应 schema parse 一次,替代 `as XxxParams` 转型
 *
 * 设计取舍：
 * - schema 放宽于 chrome.* API 类型（只校验 MCP server 传入合同字段）
 * - 不在此处校验 mutex 关系（如 selector/text/xpath 至少一个），由业务方层处理
 */

import { z } from 'zod'

const tabIdOpt = z.number().int().nonnegative().optional()
const frameIdOpt = z.number().int().nonnegative().optional()
const refIdOpt = z.string().min(1).optional()
const refIdReq = z.string().min(1)
const waitUntil = z.enum(['load', 'domcontentloaded', 'networkidle']).optional()

// ==================== Tabs ====================

export const TabsListSchema = z
    .object({
        windowId: z.number().int().optional(),
        active: z.boolean().optional(),
    })
    .partial()
    .optional()

export const TabsCreateSchema = z
    .object({
        url: z.string().optional(),
        active: z.boolean().optional(),
        windowId: z.number().int().optional(),
        groupId: z.number().int().optional(),
        waitUntil,
        timeout: z.number().nonnegative().optional(),
    })
    .partial()
    .optional()

export const TabsCloseSchema = z.object({
    tabId: z.number().int().nonnegative(),
})

export const TabsActivateSchema = z.object({
    tabId: z.number().int().nonnegative(),
})

export const TabGroupCreateSchema = z.object({
    tabIds: z.array(z.number().int().nonnegative()).min(1),
    title: z.string().optional(),
    color: z.string().optional() as z.ZodOptional<z.ZodType<chrome.tabGroups.ColorEnum>>,
})

export const TabGroupAddSchema = z.object({
    tabId: z.number().int().nonnegative(),
    groupId: z.number().int().optional(),
})

// ==================== Navigation ====================

export const NavigateSchema = z.object({
    tabId: tabIdOpt,
    url: z.string().min(1),
    waitUntil,
    timeout: z.number().nonnegative().optional(),
})

export const GoBackSchema = z
    .object({
        tabId: tabIdOpt,
        waitUntil,
        timeout: z.number().nonnegative().optional(),
    })
    .partial()
    .optional()

export const GoForwardSchema = GoBackSchema

export const ReloadSchema = z
    .object({
        tabId: tabIdOpt,
        ignoreCache: z.boolean().optional(),
        waitUntil,
        timeout: z.number().nonnegative().optional(),
    })
    .partial()
    .optional()

// ==================== Page content ====================

export const ReadPageSchema = z
    .object({
        tabId: tabIdOpt,
        frameId: frameIdOpt,
        filter: z.enum(['all', 'interactive', 'visible']).optional(),
        depth: z.number().int().nonnegative().optional(),
        maxLength: z.number().int().nonnegative().nullable().optional(),
        refId: refIdOpt,
    })
    .partial()
    .optional()

export const ScreenshotSchema = z
    .object({
        tabId: tabIdOpt,
        frameId: frameIdOpt,
        format: z.enum(['png', 'jpeg', 'webp']).optional(),
        quality: z.number().min(0).max(100).optional(),
        fullPage: z.boolean().optional(),
        scale: z.number().positive().optional(),
        clip: z
            .object({
                x: z.number(),
                y: z.number(),
                width: z.number().positive(),
                height: z.number().positive(),
            })
            .optional(),
    })
    .partial()
    .optional()

export type ScreenshotInput = z.infer<typeof ScreenshotSchema>

// ==================== DOM ops ====================

export const ClickSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    refId: refIdReq,
})

export const ActionableClickSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    refId: refIdReq,
    force: z.boolean().optional(),
})

export const CheckActionabilitySchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    refId: refIdReq,
})

export const DispatchInputSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    refId: refIdReq,
    text: z.string(),
})

export const DragAndDropSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    srcRefId: refIdReq,
    dstRefId: refIdReq,
})

export const GetComputedStyleSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    refId: refIdReq,
    prop: z.string(),
})

export const TypeSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    refId: refIdReq,
    text: z.string(),
    clear: z.boolean().optional(),
})

export const ScrollSchema = z
    .object({
        tabId: tabIdOpt,
        frameId: frameIdOpt,
        x: z.number().optional(),
        y: z.number().optional(),
        refId: refIdOpt,
    })
    .partial()
    .optional()

export const EvaluateSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    code: z.string().min(1),
})

export const FindSchema = z
    .object({
        tabId: tabIdOpt,
        frameId: frameIdOpt,
        selector: z.string().optional(),
        text: z.string().optional(),
        xpath: z.string().optional(),
    })
    .partial()
    .optional()

// ==================== Content extract ====================

export const GetTextSchema = z
    .object({
        tabId: tabIdOpt,
        frameId: frameIdOpt,
        selector: z.string().optional(),
    })
    .partial()
    .optional()

export const GetHtmlSchema = z
    .object({
        tabId: tabIdOpt,
        frameId: frameIdOpt,
        selector: z.string().optional(),
        outer: z.boolean().optional(),
    })
    .partial()
    .optional()

export const GetHtmlWithImagesSchema = GetHtmlSchema

export const GetAttributeSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    selector: z.string().optional(),
    refId: refIdOpt,
    attribute: z.string().min(1),
})

export const GetMetadataSchema = z
    .object({
        tabId: tabIdOpt,
        frameId: frameIdOpt,
    })
    .partial()
    .optional()

// ==================== Cookies ====================

export const CookiesGetSchema = z
    .object({
        url: z.string().optional(),
        name: z.string().optional(),
        domain: z.string().optional(),
        path: z.string().optional(),
        secure: z.boolean().optional(),
        session: z.boolean().optional(),
    })
    .partial()
    .optional()

export const CookiesSetSchema = z.object({
    url: z.string().min(1),
    name: z.string().min(1),
    value: z.string().optional(),
    domain: z.string().optional(),
    path: z.string().optional(),
    secure: z.boolean().optional(),
    httpOnly: z.boolean().optional(),
    sameSite: z.enum(['no_restriction', 'lax', 'strict', 'unspecified']).optional(),
    expirationDate: z.number().optional(),
})

export const CookiesDeleteSchema = z.object({
    url: z.string().min(1),
    name: z.string().min(1),
})

export const CookiesClearSchema = z
    .object({
        url: z.string().optional(),
        domain: z.string().optional(),
        name: z.string().optional(),
    })
    .partial()
    .optional()

// ==================== Debugger ====================

export const DebuggerAttachSchema = z
    .object({
        tabId: tabIdOpt,
    })
    .partial()
    .optional()

export const DebuggerDetachSchema = DebuggerAttachSchema

export const DebuggerSendSchema = z.object({
    tabId: tabIdOpt,
    method: z.string().min(1),
    params: z.record(z.unknown()).optional(),
})

// ==================== Input events ====================

export const InputKeySchema = z.object({
    tabId: tabIdOpt,
    type: z.enum(['keyDown', 'keyUp', 'rawKeyDown', 'char']),
    key: z.string().optional(),
    code: z.string().optional(),
    text: z.string().optional(),
    unmodifiedText: z.string().optional(),
    location: z.number().optional(),
    isKeypad: z.boolean().optional(),
    autoRepeat: z.boolean().optional(),
    windowsVirtualKeyCode: z.number().optional(),
    nativeVirtualKeyCode: z.number().optional(),
    modifiers: z.number().optional(),
    commands: z.array(z.string()).optional(),
})

export const InputMouseSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    type: z.enum(['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel']),
    x: z.number(),
    y: z.number(),
    button: z.enum(['none', 'left', 'middle', 'right', 'back', 'forward']).optional(),
    clickCount: z.number().int().nonnegative().optional(),
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
    modifiers: z.number().optional(),
})

export const InputTouchSchema = z
    .object({
        tabId: tabIdOpt,
        frameId: frameIdOpt,
        type: z.enum(['touchStart', 'touchMove', 'touchEnd', 'touchCancel']),
        touchPoints: z.array(
            z.object({
                x: z.number(),
                y: z.number(),
                radiusX: z.number().optional(),
                radiusY: z.number().optional(),
                force: z.number().optional(),
                id: z.number().optional(),
                rotationAngle: z.number().optional(),
            })
        ),
        modifiers: z.number().optional(),
    })
    .superRefine((value, ctx) => {
        if ((value.type === 'touchStart' || value.type === 'touchMove') && value.touchPoints.length < 1) {
            ctx.addIssue({
                code: z.ZodIssueCode.too_small,
                minimum: 1,
                type: 'array',
                inclusive: true,
                exact: false,
                path: ['touchPoints'],
                message: 'Array must contain at least 1 element(s)',
            })
        }
    })

export const InputTypeSchema = z.object({
    tabId: tabIdOpt,
    text: z.string(),
    delay: z.number().nonnegative().optional(),
})

// ==================== Console / Network ====================

const TabIdOnly = z.object({ tabId: tabIdOpt }).partial().optional()

export const ConsoleEnableSchema = TabIdOnly
export const ConsoleClearSchema = TabIdOnly
export const NetworkEnableSchema = TabIdOnly
export const NetworkClearSchema = TabIdOnly

export const ConsoleGetSchema = z
    .object({
        tabId: tabIdOpt,
        level: z.string().optional(),
        pattern: z.string().optional(),
        clear: z.boolean().optional(),
    })
    .partial()
    .optional()

export const NetworkGetSchema = z
    .object({
        tabId: tabIdOpt,
        urlPattern: z.string().optional(),
        clear: z.boolean().optional(),
    })
    .partial()
    .optional()

// ==================== Stealth ====================

export const StealthClickSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    x: z.number(),
    y: z.number(),
    button: z.string().optional(),
    clickCount: z.number().int().positive().optional(),
    refId: z.string().optional(),
})

export const StealthTypeSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    text: z.string(),
    delay: z.number().nonnegative().optional(),
})

export const StealthKeySchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    key: z.string().min(1),
    type: z.enum(['down', 'up', 'press']).optional(),
    modifiers: z.array(z.string()).optional(),
})

export const StealthMouseSchema = z.object({
    tabId: tabIdOpt,
    frameId: frameIdOpt,
    type: z.string(),
    x: z.number(),
    y: z.number(),
    button: z.string().optional(),
})

export const StealthInjectSchema = z
    .object({
        tabId: tabIdOpt,
        frameId: frameIdOpt,
    })
    .partial()
    .optional()

// ==================== Frame ====================

export const ResolveFrameSchema = z.object({
    tabId: tabIdOpt,
    frame: z.union([z.string().min(1), z.number().int().nonnegative()]),
})

export const GetAllFramesSchema = TabIdOnly

export const EvaluateInFrameSchema = z.object({
    tabId: tabIdOpt,
    frameId: z.number().int().nonnegative(),
    expression: z.string().min(1),
    timeout: z.number().nonnegative().optional(),
})
