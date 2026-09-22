import { Router } from "express"

/**
 * 生日紅包登記（birthday_gifts；M7）——**WP0 stub**，端點由 WP8 填：
 *   GET /birthday-gifts/upcoming?month=、GET /birthday-gifts?year=、POST /birthday-gifts、
 *   PATCH /:id、POST /:id/photo（base64）、DELETE /:id/photo（HR；照片 signed URL 900s）
 */
export const birthdayGiftsRouter = Router()
