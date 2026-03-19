import {
  Injectable,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Report } from '../../entities/report.entity';
import { RoomUser } from '../../entities/room-user.entity';

const VALID_REASONS = ['spam', 'harassment', 'illegal_content', 'other'];

export interface CreateReportDto {
  reportedUserId: number;
  roomId: number;
  messageId?: string;
  reason: string;
  description?: string;
}

@Injectable()
export class ModerationService {
  constructor(
    @InjectRepository(Report)
    private reportRepository: Repository<Report>,
    @InjectRepository(RoomUser)
    private roomUserRepository: Repository<RoomUser>,
  ) {}

  async createReport(
    reporterUserId: number,
    dto: CreateReportDto,
  ): Promise<Report> {
    if (!VALID_REASONS.includes(dto.reason)) {
      throw new BadRequestException(
        `Invalid reason. Must be one of: ${VALID_REASONS.join(', ')}`,
      );
    }

    if (dto.reportedUserId === reporterUserId) {
      throw new BadRequestException('Cannot report yourself');
    }

    // Verify reporter is a member of the room
    const membership = await this.roomUserRepository.findOne({
      where: { roomId: dto.roomId, userId: reporterUserId },
    });
    if (!membership) {
      throw new ForbiddenException('You are not a member of this room');
    }

    const report = this.reportRepository.create({
      reporterUserId,
      reportedUserId: dto.reportedUserId,
      roomId: dto.roomId,
      messageId: dto.messageId || null,
      reason: dto.reason,
      description: dto.description || null,
      status: 'pending',
      createdAt: Date.now(),
    });

    return this.reportRepository.save(report);
  }

  async getReports(status?: string): Promise<Report[]> {
    const where = status ? { status } : {};
    return this.reportRepository.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async updateReportStatus(
    reportId: number,
    status: string,
  ): Promise<boolean> {
    const result = await this.reportRepository.update(reportId, { status });
    return (result.affected ?? 0) > 0;
  }
}
