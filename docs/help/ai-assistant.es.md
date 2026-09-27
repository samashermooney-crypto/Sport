---
title: 'Asistencia de IA'
summary: 'Funciones opcionales de IA: borradores de formularios, traducción y un asistente de ayuda para familias — y cómo activarlas.'
category: 'Funciones de IA'
audience: 'admin'
order: 30
---

# Asistencia de IA

Athlentry incluye funciones opcionales de IA. Permanecen **desactivadas hasta que el operador de la plataforma configure un proveedor y habilite la función**. Cuando están desactivadas, no aparecen los controles de IA ni se envían solicitudes de IA.

## Qué puede hacer la IA

- **Crear borradores de formularios desde documentos** — suba un PDF, Word o texto para preparar un borrador. Revíselo antes de guardarlo; nunca se aplica automáticamente.
- **Traducir texto** — traduzca texto entre inglés y español y edítelo antes de usarlo.
- **Asistente de ayuda para familias** — si su organización tiene programas públicos, el chat responde preguntas generales con detalles públicos de programas e instalaciones y artículos de ayuda para familias. Cita la fuente. Rechaza preguntas sobre un menor específico, saldo, pago o tema médico.

## Privacidad

- Los correos electrónicos y teléfonos se eliminan de las instrucciones, borradores guardados, traducciones y respuestas del asistente.
- Las conversaciones del asistente se conservan como máximo 30 días y luego se eliminan.
- Cada solicitud registra la organización, función, modelo, cantidad de tokens, redacciones y resultado.
- Los límites mensuales siguen el plan de la organización y también se limitan los periodos breves de uso intenso.

## Activación

El operador de la plataforma habilita la IA por entorno. Requiere `AI_PROVIDER=anthropic` y una clave de API de Anthropic. Cuando esté disponible, el borrador de formularios y la traducción aparecen en Asistencia de IA; las familias ven el asistente en Ayuda solo cuando hay contenido de programas públicos.
