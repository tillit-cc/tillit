import {
  Controller,
  Post,
  Body,
  Req,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { ModerationService, CreateReportDto } from './moderation.service';
import { AuthenticatedRequest } from '../../common/types/authenticated-request';

@Controller('moderation')
@UseGuards(AuthGuard('jwt'))
export class ModerationController {
  constructor(private moderationService: ModerationService) {}

  @Post('report')
  @HttpCode(201)
  async createReport(
    @Req() req: AuthenticatedRequest,
    @Body() body: CreateReportDto,
  ) {
    const report = await this.moderationService.createReport(
      req.user.userId,
      body,
    );
    return { success: true, reportId: report.id };
  }
}
