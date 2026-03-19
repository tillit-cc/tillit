import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ModerationService } from './moderation.service';
import { Report } from '../../entities/report.entity';
import { RoomUser } from '../../entities/room-user.entity';
import { createMockRepository } from '../../test/helpers';

describe('ModerationService', () => {
  let service: ModerationService;
  let reportRepo: ReturnType<typeof createMockRepository> & {
    update?: jest.Mock;
  };
  let roomUserRepo: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    reportRepo = createMockRepository();
    roomUserRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        { provide: getRepositoryToken(Report), useValue: reportRepo },
        { provide: getRepositoryToken(RoomUser), useValue: roomUserRepo },
      ],
    }).compile();

    service = module.get<ModerationService>(ModerationService);
  });

  describe('createReport', () => {
    const validDto = {
      reportedUserId: 2,
      roomId: 1,
      reason: 'spam',
      description: 'Sending spam messages',
    };

    it('should create a report successfully', async () => {
      roomUserRepo.findOne.mockResolvedValue({
        roomId: 1,
        userId: 1,
      });

      const result = await service.createReport(1, validDto);

      expect(reportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          reporterUserId: 1,
          reportedUserId: 2,
          roomId: 1,
          reason: 'spam',
          status: 'pending',
        }),
      );
      expect(reportRepo.save).toHaveBeenCalled();
    });

    it('should reject invalid reason', async () => {
      await expect(
        service.createReport(1, { ...validDto, reason: 'invalid_reason' }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject self-report', async () => {
      await expect(
        service.createReport(2, { ...validDto, reportedUserId: 2 }),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject if reporter is not a room member', async () => {
      roomUserRepo.findOne.mockResolvedValue(null);

      await expect(service.createReport(1, validDto)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should handle report without messageId', async () => {
      roomUserRepo.findOne.mockResolvedValue({
        roomId: 1,
        userId: 1,
      });

      await service.createReport(1, {
        reportedUserId: 2,
        roomId: 1,
        reason: 'harassment',
      });

      expect(reportRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: null,
          description: null,
        }),
      );
    });
  });

  describe('getReports', () => {
    it('should return all reports when no status filter', async () => {
      reportRepo.find.mockResolvedValue([]);
      await service.getReports();
      expect(reportRepo.find).toHaveBeenCalledWith({
        where: {},
        order: { createdAt: 'DESC' },
      });
    });

    it('should filter by status', async () => {
      reportRepo.find.mockResolvedValue([]);
      await service.getReports('pending');
      expect(reportRepo.find).toHaveBeenCalledWith({
        where: { status: 'pending' },
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('updateReportStatus', () => {
    it('should update report status', async () => {
      reportRepo.update = jest.fn().mockResolvedValue({ affected: 1 });
      const result = await service.updateReportStatus(1, 'reviewed');
      expect(result).toBe(true);
      expect(reportRepo.update).toHaveBeenCalledWith(1, {
        status: 'reviewed',
      });
    });

    it('should return false for non-existent report', async () => {
      reportRepo.update = jest.fn().mockResolvedValue({ affected: 0 });
      const result = await service.updateReportStatus(999, 'reviewed');
      expect(result).toBe(false);
    });
  });
});
