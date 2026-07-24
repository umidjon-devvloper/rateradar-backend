import { Router } from 'express';
import { submitLead } from '../controllers/lead.controller.js';

const router = Router();

/**
 * @openapi
 * /leads:
 *   post:
 *     tags: [Leads]
 *     summary: Landing bog'lanish formasi — so'rovni egasi pochtasiga yuboradi
 *     security: []
 *     responses:
 *       200: { description: "{ ok: true }" }
 */
router.post('/', submitLead);

export default router;
