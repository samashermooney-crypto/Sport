---
title: 'Importar sus datos'
summary: 'Traiga personas, plantillas, calendarios, instalaciones, credenciales, historial de pagos y horas de voluntariado desde hojas de cálculo.'
category: 'Importaciones'
audience: 'admin'
order: 10
---

# Importar sus datos

Athlentry importa archivos CSV y Excel (.xlsx), además de archivos ZIP con documentos para credenciales. Vaya a **Consola → Importaciones** y elija qué desea importar.

## Qué puede importar

| Importación           | Notas                                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- |
| Personas              | Jugadores, tutores y contactos, con contactos de emergencia.                                  |
| Hogares               | Agrupaciones familiares con relaciones de facturación.                                        |
| Registros             | Registros históricos, vinculados a programas.                                                 |
| Equipos               | Equipos dentro de una temporada o división.                                                   |
| Plantillas            | Asignaciones de jugadores y entrenadores a equipos.                                           |
| Calendario            | Partidos y eventos, vinculados a equipos e instalaciones.                                     |
| Instalaciones         | Canchas, campos y sedes.                                                                      |
| Credenciales          | Certificaciones y verificaciones del personal, con fechas de vencimiento y documentos en ZIP. |
| Historial de pagos    | Pagos históricos registrados como _externos_ — nunca se vuelven a cobrar.                     |
| Horas de voluntariado | Registros anteriores de servicio voluntario.                                                  |

## Cómo funciona una importación

1. **Suba** su archivo CSV, XLSX o ZIP.
2. **Asigne columnas** — Athlentry sugiere una asignación automática; ajústela y guárdela como preajuste.
3. **Valide** — cada fila se verifica y normaliza. Las filas con errores se listan para corregir el archivo o omitirlas.
4. **Revise duplicados** — las filas que coinciden con personas o equipos existentes se marcan; elija crear, actualizar, combinar u omitir por fila.
5. **Confirme** — los registros se crean dentro de su organización.
6. **Revierta** — si algo sale mal, revierta el lote. La reversión respeta los cambios hechos después de la importación.

Descargue una plantilla desde la página de Importaciones para ver las columnas exactas.

## Consejos

- Importe **instalaciones antes del calendario** y **personas antes que plantillas**.
- Los números de teléfono se normalizan a formato internacional; los no válidos se conservan como advertencias.
- Los documentos de credenciales dentro de un ZIP se guardan automáticamente.
