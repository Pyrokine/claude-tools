/**
 * 行为模拟
 *
 * 模拟人类操作行为，包括：
 * - 贝塞尔曲线鼠标移动
 * - 随机延迟
 * - 打字速度变化
 *
 * 注意：这些是可选功能，需要显式启用（humanize: true）
 */

import type { Point } from '../core/types.js'

/**
 * 随机延迟
 */
export function randomDelay(min: number, max: number): Promise<void> {
    const ms = min + Math.random() * (max - min)
    return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 生成贝塞尔曲线路径点
 *
 * @param from 起点
 * @param to 终点
 * @param steps 步数（默认根据距离计算）
 * @returns 路径点数组
 */
export function generateBezierPath(from: Point, to: Point, steps?: number): Point[] {
    // 计算距离
    const distance = Math.sqrt(Math.pow(to.x - from.x, 2) + Math.pow(to.y - from.y, 2))

    // 根据距离计算步数，距离越远步数越多
    const numSteps = steps ?? Math.max(20, Math.floor(distance / 10))

    // 生成随机控制点
    const control1: Point = {
        x: from.x + (to.x - from.x) * 0.3 + (Math.random() - 0.5) * 50,
        y: from.y + (to.y - from.y) * 0.1 + (Math.random() - 0.5) * 50,
    }

    const control2: Point = {
        x: from.x + (to.x - from.x) * 0.7 + (Math.random() - 0.5) * 50,
        y: from.y + (to.y - from.y) * 0.9 + (Math.random() - 0.5) * 50,
    }

    const points: Point[] = []

    for (let i = 0; i <= numSteps; i++) {
        const t = i / numSteps
        points.push(bezierPoint(from, control1, control2, to, t))
    }

    return points
}

/**
 * 计算三次贝塞尔曲线上的点
 */
function bezierPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
    const u = 1 - t
    const tt = t * t
    const uu = u * u
    const uuu = uu * u
    const ttt = tt * t

    return {
        x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
        y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
    }
}

/**
 * 获取随机打字延迟（模拟人类打字速度）
 *
 * @param baseDelay 基础延迟（毫秒）
 * @returns 随机化后的延迟
 */
export function getTypingDelay(baseDelay: number = 100): number {
    // 添加 ±50% 的随机变化
    const variation = baseDelay * 0.5
    return baseDelay + (Math.random() - 0.5) * 2 * variation
}

/**
 * 获取鼠标移动间隔延迟
 */
export function getMouseMoveDelay(): number {
    // 5-15ms 随机延迟
    return 5 + Math.random() * 10
}

/**
 * 行为模拟器
 */
export class BehaviorSimulator {
    private currentPosition: Point = { x: 0, y: 0 }

    /**
     * 获取当前鼠标位置
     */
    getCurrentPosition(): Point {
        return { ...this.currentPosition }
    }

    /**
     * 更新当前鼠标位置
     */
    setCurrentPosition(point: Point): void {
        this.currentPosition = { ...point }
    }
}
