import nodemailer from 'nodemailer';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export class FakeEmailSender implements EmailSender {
  readonly messages: EmailMessage[] = [];

  send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
    return Promise.resolve();
  }
}

export function createMailpitEmailSender(): EmailSender {
  const transport = nodemailer.createTransport({
    host: '127.0.0.1',
    port: 1025,
    secure: false,
  });
  return {
    async send(message) {
      await transport.sendMail({
        from: 'Athlentry Preview <preview@athlentry.invalid>',
        ...message,
      });
    },
  };
}
