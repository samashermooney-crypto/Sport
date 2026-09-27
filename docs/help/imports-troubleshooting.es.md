---
title: "Solución de problemas de importación"
summary: "Errores comunes de importación y cómo resolverlos."
category: "Importaciones"
audience: "admin"
order: 12
---
# Solución de problemas de importación

## "Falta una columna requerida"

El validador lista las columnas que no encontró. Abra el paso de asignación y apunte cada campo requerido a la columna correcta de su archivo, o agregue la columna. Guardar la asignación corregida como preajuste evita tener que arreglarla de nuevo.

## Filas marcadas como duplicadas

Un duplicado significa que la clave de la fila (normalmente nombre + fecha de nacimiento para personas, o nombre + temporada para equipos) ya existe en su organización. Para cada duplicado elija **crear**, **actualizar**, **combinar** u **omitir**.

## Filas omitidas durante la confirmación

Las filas con errores de validación se omiten, no cancelan el lote — el resto se confirma. Corrija las filas indicadas en su archivo y ejecute una segunda importación; las filas confirmadas no se duplican.

## Filas de calendario que no encuentran equipo o instalación

Las importaciones de calendario vinculan equipos e instalaciones por nombre. Importe las instalaciones primero y asegúrese de que los nombres de equipos coincidan exactamente con los creados por la importación de Equipos. Las instalaciones no encontradas se crean automáticamente como advertencias.

## Reversión

**Importaciones → [lote] → Revertir** elimina todo lo que el lote creó. Los registros modificados desde la importación no se tocan — la reversión solo elimina datos que siguen exactamente como los escribió la importación.
