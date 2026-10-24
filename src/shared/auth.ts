import type { FastifyReply, FastifyRequest } from 'fastify';

export function bearerAuth(expectedToken: string) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization !== `Bearer ${expectedToken}`) {
      reply.code(401).send({ error: 'unauthorized' });
      return reply;
    }
  };
}
