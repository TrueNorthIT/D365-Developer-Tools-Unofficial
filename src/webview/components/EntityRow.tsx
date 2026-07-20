import type { AttributeInfo, EntityInfo } from '../protocol';
import { iconKey } from '../helpers';
import { useAttributes, useIcon } from '../queries';
import { EntityIcon } from './EntityIcon';
import { AttributeList } from './AttributeList';

interface Props {
  entity: EntityInfo;
  isExpanded: boolean;
  onToggle: (logicalName: string) => void;
  onEntityContextMenu: (entity: EntityInfo, x: number, y: number) => void;
  onAttrContextMenu: (attr: AttributeInfo, x: number, y: number) => void;
}

export function EntityRow({ entity, isExpanded, onToggle, onEntityContextMenu, onAttrContextMenu }: Props) {
  const icon = useIcon(iconKey(entity));
  const attributes = useAttributes(entity.logicalName, isExpanded);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    onEntityContextMenu(entity, e.clientX, e.clientY);
  };

  return (
    <div>
      <div
        className={'entity-header' + (isExpanded ? ' expanded' : '')}
        onClick={() => onToggle(entity.logicalName)}
        onContextMenu={handleContextMenu}
      >
        <EntityIcon content={icon.data} />
        <span className="entity-name">{entity.displayName || entity.logicalName}</span>
        <span className="entity-lname">{entity.logicalName}</span>
      </div>
      {isExpanded && <AttributeList query={attributes} onAttrContextMenu={onAttrContextMenu} />}
    </div>
  );
}
