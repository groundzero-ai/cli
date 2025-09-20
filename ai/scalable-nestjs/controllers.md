---
# GroundZero formula
formula:
  name: scalable-nestjs
---

# NestJS Controller Guidelines

## Overview
This document outlines best practices for writing clean, maintainable, and secure NestJS controllers that follow established patterns for HTTP request handling, authentication, validation, and error management.

## Core Principles

### 1. Single Responsibility
- Controllers should only handle HTTP request/response logic
- Business logic belongs in services
- Keep controllers thin and focused on routing

### 2. Proper Separation of Concerns
```typescript
@Controller('users')
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  async findAll() {
    return this.userService.findAll();
  }
}
```

## Structure and Organization

### Controller Class Structure
```typescript
@Controller('resource')
export class ResourceController {
  constructor(
    private readonly resourceService: ResourceService,
    // Other dependencies
  ) {}

  // Routes ordered by CRUD operations
  @Post()
  create(@Body() dto: CreateDto) {}

  @Get()
  findAll() {}

  @Get(':id')
  findOne(@Param('id') id: string) {}

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateDto) {}

  @Delete(':id')
  remove(@Param('id') id: string) {}
}
```

### Route Organization
- Order routes from simplest to complex, then by CRUD operations
- Group related routes together
- Use consistent parameter naming (e.g., `:id`, `:resourceId`)

## HTTP Methods and Status Codes

### Proper HTTP Method Usage
```typescript
@Post()                    // Create resources
@Get()                     // Retrieve resources
@Patch()                   // Partial updates
@Put()                     // Full updates
@Delete()                  // Remove resources
@Head()                    // Check resource existence
```

### HTTP Status Code Handling
```typescript
@Post()
@HttpCode(HttpStatus.CREATED)
async create(@Body() dto: CreateDto) {
  return this.service.create(dto);
}

@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
async remove(@Param('id') id: string) {
  await this.service.remove(id);
}
```

## Authentication and Authorization

### Guard Implementation
```typescript
@UseGuards(JwtAuthGuard)
@Get('protected')
async getProtectedData(@Request() req) {
  return this.service.getData(req.user.id);
}
```

### Permission-Based Access Control
```typescript
@UseGuards(JwtAuthGuard, PermissionGuard)
@RequirePermission(PermissionRole.ADMIN)
@Post()
async create(@Body() dto: CreateDto) {
  return this.service.create(dto);
}
```

### Request Interface Definition
```typescript
interface AuthenticatedRequest {
  user: UserDocument;
  // Other request properties
}

@Get('profile')
async getProfile(@Request() req: AuthenticatedRequest) {
  return req.user;
}
```

## Input Validation and DTOs

### DTO Usage for Input Validation
```typescript
@Post()
async create(@Body() createDto: CreateResourceDto) {
  return this.service.create(createDto);
}
```

### Query Parameter Validation
```typescript
@Get()
async findAll(
  @Query('page') page?: string,
  @Query('limit') limit?: string,
) {
  const pageNumber = page ? parseInt(page, 10) : 1;
  const limitNumber = limit ? parseInt(limit, 10) : 10;

  if (pageNumber < 1 || limitNumber < 1 || limitNumber > 100) {
    throw new BadRequestException('Invalid pagination parameters');
  }

  return this.service.findAll({ page: pageNumber, limit: limitNumber });
}
```

## Error Handling

### Built-in Exception Usage
```typescript
import {
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';

@Get(':id')
async findOne(@Param('id') id: string) {
  const resource = await this.service.findOne(id);
  if (!resource) {
    throw new NotFoundException(`Resource with id ${id} not found`);
  }
  return resource;
}
```

### Input Validation Errors
```typescript
@Post()
async create(@Body() createDto: CreateDto) {
  try {
    return await this.service.create(createDto);
  } catch (error) {
    if (error.code === 11000) { // MongoDB duplicate key
      throw new ConflictException('Resource already exists');
    }
    throw error;
  }
}
```

## Response Formatting

### Consistent Response Structure
```typescript
// For successful operations
return {
  data: result,
  message: 'Operation successful'
};

// For collections
return {
  data: items,
  total: totalCount,
  page: pageNumber,
  limit: pageSize
};
```

### Empty Responses
```typescript
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
async remove(@Param('id') id: string) {
  await this.service.remove(id);
  // No return statement - 204 No Content
}
```

## Streaming and Long-Running Operations

### Server-Sent Events (SSE)
```typescript
@Get('stream')
async stream(@Res() res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = await this.service.getStream();

  for await (const chunk of stream) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }

  res.end();
}
```

### Stream Cleanup
```typescript
@Get('stream')
async stream(@Res() res: Response) {
  let interval: NodeJS.Timeout;

  const cleanup = () => {
    if (interval) clearInterval(interval);
    if (!res.writableEnded) res.end();
  };

  res.on('close', cleanup);
  res.on('error', cleanup);

  try {
    // Stream implementation
  } finally {
    cleanup();
  }
}
```

## Method Naming and Documentation

### Clear Method Names
```typescript
// ✅ Good
async createUser(@Body() dto: CreateUserDto) {}
async getUserById(@Param('id') id: string) {}
async updateUserProfile(@Param('id') id: string, @Body() dto: UpdateDto) {}
async deleteUser(@Param('id') id: string) {}

// ❌ Avoid
async create(@Body() dto: CreateUserDto) {}      // Too generic
async get(@Param('id') id: string) {}           // Unclear what is retrieved
async update(@Param('id') id: string) {}        // Unclear what is updated
```

### JSDoc Documentation
```typescript
/**
 * Creates a new user account
 * @param createUserDto User creation data
 * @param req Request object containing user context
 * @returns Created user information
 */
@Post()
async createUser(
  @Body() createUserDto: CreateUserDto,
  @Request() req: AuthenticatedRequest
) {
  return this.userService.create(createUserDto, req.user.id);
}
```

## Helper Methods

### Private Helper Methods
```typescript
@Post('login')
async login(@Body() loginDto: LoginDto, @Request() req) {
  const deviceInfo = this.extractDeviceInfo(req);
  return this.authService.login(loginDto, deviceInfo);
}

private extractDeviceInfo(req: any) {
  return {
    userAgent: req.headers['user-agent'],
    ip: req.ip || req.connection?.remoteAddress,
  };
}
```

## Testing Considerations

### Controller Testing Structure
```typescript
describe('UserController', () => {
  let controller: UserController;
  let service: UserService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      controllers: [UserController],
      providers: [UserService],
    }).compile();

    controller = module.get<UserController>(UserController);
    service = module.get<UserService>(UserService);
  });

  it('should return users', async () => {
    const result = [{ id: 1, name: 'Test' }];
    jest.spyOn(service, 'findAll').mockResolvedValue(result);

    expect(await controller.findAll()).toBe(result);
  });
});
```

## Security Best Practices

### Input Sanitization
- Always use DTOs with class-validator decorators
- Validate and sanitize all inputs
- Use appropriate parameter types

### Rate Limiting
```typescript
@UseGuards(ThrottleGuard)
@Post('login')
async login(@Body() loginDto: LoginDto) {
  // Implementation
}
```

### CORS Configuration
```typescript
@Controller('api')
@UseGuards(CorsGuard)
export class ApiController {
  // Routes
}
```

## Performance Optimization

### Efficient Query Handling
```typescript
@Get()
async findAll(@Query() query: FindAllQuery) {
  // Use pagination to prevent large result sets
  const { page = 1, limit = 10 } = query;
  return this.service.findAll({ page, limit });
}
```

### Resource Cleanup
- Always clean up streams and intervals
- Use proper error handling to prevent resource leaks
- Implement connection timeouts for long-running operations

## Common Patterns to Avoid

### ❌ Don't put business logic in controllers
```typescript
// Bad
@Post()
async create(@Body() dto: CreateDto) {
  // Complex business logic here
  const user = await this.userRepository.findOne(dto.userId);
  const permissions = await this.permissionService.check(user);
  // ... more logic
  return result;
}
```

### ❌ Don't return raw database objects
```typescript
// Bad
@Get(':id')
async findOne(@Param('id') id: string) {
  return await this.repository.findOne(id); // Exposes internal structure
}
```

### ❌ Don't use generic exception handling
```typescript
// Bad
try {
  return await this.service.operation();
} catch (error) {
  throw new BadRequestException('Something went wrong');
}
```

## Summary

Following these guidelines ensures controllers that are:
- **Secure**: Proper authentication, authorization, and input validation
- **Maintainable**: Clear structure, documentation, and separation of concerns
- **Performant**: Efficient queries, proper resource management, and streaming support
- **Testable**: Clean interfaces and predictable behavior
- **Consistent**: Following established patterns across the application

Remember: Controllers are the API boundary - keep them focused on HTTP concerns while delegating business logic to services.
